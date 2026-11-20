import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, DatePicker, Divider, Form, Input, InputNumber, Modal, Radio, Row, Select, Skeleton, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, BulbOutlined, DeleteOutlined, ExperimentOutlined, FolderOpenOutlined, InfoCircleOutlined, KeyOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  buildDestinationFolder,
  buildFileName,
  formatDate,
  unknownTokens,
  DATE_FORMAT_PARTS_HELP,
  DATE_FORMAT_PRESETS,
  PATTERN_TOKENS,
  PATTERN_TOKEN_HELP,
  type PatternToken,
} from '@mailvault/core';
import type { DestinationStatus, RuleInput } from '@mailvault/shared';
import { api } from '../api';
import { useConfirm } from './confirm';
import { DestinationStatusTag } from './ui';
import { TestResults, type TestEmail } from './TestResults';

interface Mailbox {
  id: string;
  email: string;
}
interface Destination {
  id: string;
  name: string;
  basePath: string;
  status: DestinationStatus;
}

export interface RuleRecord extends RuleInput {
  id: string;
  currentVersion: number;
  /** How many file passwords are saved (the passwords themselves never reach the browser). */
  filePasswordCount?: number;
}

type FormValues = Omit<RuleInput, 'conditions'> & {
  conditions: RuleInput['conditions'] & { range?: [Dayjs, Dayjs] };
};

const EXTENSIONS = ['pdf', 'xls', 'xlsx', 'csv', 'doc', 'docx', 'zip', 'jpg', 'jpeg', 'png', 'txt', 'xml', 'json', 'eml', 'msg'];

const DEFAULTS: FormValues = {
  name: '',
  description: '',
  mailboxId: '',
  enabled: true,
  priority: 100,
  stopFurtherRules: false,
  simulationMode: false,
  conditions: {
    senderInclude: [],
    senderExclude: [],
    recipients: [],
    cc: [],
    subjectKeywords: [],
    keywordMode: 'ANY',
    ignoreReplyPrefixes: true,
    range: undefined,
  },
  attachments: { mode: 'SELECTED', extensions: ['pdf'], excludeNames: [], allowMultiple: true, includeInline: false, extractArchives: false, extractEmails: false, keepContainer: false },
  download: {
    destinationId: '',
    subfolderPattern: '{SenderDomain}\\{yyyy}\\{MM}',
    dateSubfolders: false,
    senderSubfolders: false,
    fileNamePattern: '{OriginalName}',
    duplicatePolicy: 'SMART',
    autoDownload: true,
    setFileDateToReceived: true,
    unlockProtected: false,
    emailPdf: 'OFF',
    emailPdfNamePattern: '{yyyyMMdd}_{Subject}',
    emailPdfRemoteImages: false,
  },
};

const addressRule = {
  validator: async (_: unknown, list?: string[]) => {
    const bad = (list ?? []).filter((v) => !/^(\*|[^\s@]+)@[^\s@]+\.[^\s@]+$/.test(v.trim()));
    if (bad.length) throw new Error(`Not an email or *@domain: ${bad.join(', ')}`);
  },
};

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="mv-card" size="small" style={{ marginBottom: 16 }} styles={{ body: { padding: 20 } }}>
      <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
      {hint && <div className="mv-muted" style={{ marginBottom: 16, fontSize: 13 }}>{hint}</div>}
      {children}
    </Card>
  );
}

/** Full-page rule editor (routes /rules/new and /rules/:id). onDone returns to the rules list. */
export function RuleEditor({ rule, onDone }: { rule: RuleRecord | null; onDone: () => void }) {
  const { message } = App.useApp();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<Mailbox[]>('/api/mailboxes') });
  const destinations = useQuery({ queryKey: ['destinations'], queryFn: () => api.get<Destination[]>('/api/destinations') });

  // File passwords: null = keep what is saved, list = replace (empty list = remove).
  const [passwords, setPasswords] = useState<string[] | null>(null);

  // Fill the form once per rule. Background refreshes of the mailbox/folder lists must not wipe what was typed.
  const filledFor = useRef<string | null>(null);
  useEffect(() => {
    const key = rule?.id ?? 'new';
    if (filledFor.current === key) return;
    if (!rule && (!mailboxes.data || !destinations.data)) return; // new rule: wait for the default mailbox/folder
    filledFor.current = key;
    form.resetFields();
    setPasswords(null);
    if (rule) {
      const c = rule.conditions;
      form.setFieldsValue({
        ...rule,
        conditions: { ...DEFAULTS.conditions, ...c, range: c.receivedFrom || c.receivedTo ? ([dayjs(c.receivedFrom), dayjs(c.receivedTo)] as [Dayjs, Dayjs]) : undefined },
        attachments: { ...DEFAULTS.attachments, ...rule.attachments },
        download: { ...DEFAULTS.download, ...rule.download },
      });
    } else {
      form.setFieldsValue({ ...DEFAULTS, mailboxId: mailboxes.data?.[0]?.id ?? '', download: { ...DEFAULTS.download, destinationId: destinations.data?.[0]?.id ?? '' } });
    }
    // Snapshot of the loaded values (after the fields settle) to tell whether anything really changed.
    setTimeout(() => (snapshot.current = JSON.stringify(form.getFieldsValue(true))), 0);
  }, [rule, form, mailboxes.data, destinations.data]);

  // Leaving with unsaved changes asks first (Back/Cancel here; closing or reloading the tab via the browser).
  const snapshot = useRef<string | null>(null);
  const savedRef = useRef(false);
  const passwordsRef = useRef(passwords);
  passwordsRef.current = passwords;
  const dirty = () =>
    !savedRef.current && snapshot.current !== null && (passwordsRef.current !== null || JSON.stringify(form.getFieldsValue(true)) !== snapshot.current);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty()) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [form, passwords]);
  const leave = () => {
    if (!dirty()) return onDone();
    void confirm({
      tone: 'warning',
      title: 'Leave without saving?',
      description: 'Your changes to this rule will be lost.',
      okText: 'Leave without saving',
      cancelText: 'Keep editing',
    }).then((ok) => ok && onDone());
  };

  const toInput = (v: FormValues): RuleInput => {
    const { range, ...conditions } = v.conditions;
    const clean = (s?: string) => (s && s.trim() ? s.trim() : undefined);
    return {
      ...v,
      description: clean(v.description),
      conditions: {
        ...conditions,
        subjectContains: clean(conditions.subjectContains),
        subjectExact: clean(conditions.subjectExact),
        bodyContains: clean(conditions.bodyContains),
        receivedFrom: range?.[0]?.startOf('day').toISOString(),
        receivedTo: range?.[1]?.endOf('day').toISOString(),
      },
      attachments: { ...v.attachments, nameContains: clean(v.attachments.nameContains) },
    };
  };

  // "Test this rule": runs the unsaved rule against the last 14 days of real mail.
  const [testOpen, setTestOpen] = useState(false);
  const test = useMutation({
    mutationFn: async () => {
      const v = await form.validateFields();
      setTestOpen(true);
      return api.post<{ scanned: number; emails: TestEmail[] }>('/api/rule-testing/search', {
        mailboxId: v.mailboxId,
        from: dayjs().subtract(14, 'day').startOf('day').toISOString(),
        to: dayjs().toISOString(),
        limit: 50,
        draftRule: toInput(v),
      });
    },
  });
  const draftMatches = (test.data?.emails ?? []).filter((e) => e.rules.find((r) => r.ruleId === 'draft')?.matched);

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const body = { ...toInput(v), ...(passwords !== null ? { filePasswords: passwords.map((p) => p.trim()).filter(Boolean) } : {}) };
      return rule ? api.put(`/api/rules/${rule.id}`, body) : api.post('/api/rules', body);
    },
    onSuccess: () => {
      message.success(rule ? `Rule saved as version ${rule.currentVersion + 1}. Changes apply to new emails.` : 'Rule created. It applies to emails received from now on.');
      savedRef.current = true;
      void qc.invalidateQueries({ queryKey: ['rules'] });
      onDone();
    },
    onError: (e: Error) => message.error(e.message),
  });

  // Live preview
  const values = Form.useWatch([], form) as FormValues | undefined;
  const preview = useMemo(() => {
    if (!values?.download) return null;
    const dest = destinations.data?.find((d) => d.id === values.download.destinationId);
    const mb = mailboxes.data?.find((m) => m.id === values.mailboxId);
    const sample = values.conditions?.senderInclude?.[0]?.replace('*@', 'billing@') || 'billing@vendor.com';
    const ctx = {
      receivedAt: new Date(),
      timeZone: 'Asia/Kolkata',
      senderEmail: sample,
      senderName: sample.split('@')[0],
      subject: values.conditions?.subjectContains || values.conditions?.subjectKeywords?.[0] || 'Invoice 1042',
      ruleName: values.name || 'Rule',
      mailbox: mb?.email ?? 'mailbox@company.com',
    };
    const ext = values.attachments?.mode === 'SELECTED' && values.attachments.extensions?.[0] ? values.attachments.extensions[0] : 'pdf';
    const original = `INV-1042.${ext}`;
    const folder = buildDestinationFolder(dest?.basePath ?? 'D:\\Destination', values.download, ctx);
    const file = buildFileName(values.download.fileNamePattern, original, ctx);
    const emailPdf = values.download.emailPdf && values.download.emailPdf !== 'OFF' ? buildFileName(values.download.emailPdfNamePattern, `${ctx.subject}.pdf`, ctx) : null;
    return { folder, file, emailPdf, onlyEmailPdf: values.download.emailPdf === 'ONLY', sample, dest };
  }, [values, destinations.data, mailboxes.data]);

  const summary = useMemo(() => {
    if (!values?.conditions) return [];
    const c = values.conditions;
    const lines: string[] = [];
    if (c.senderInclude?.length) lines.push(`From ${c.senderInclude.join(' or ')}`);
    if (c.senderExclude?.length) lines.push(`Not from ${c.senderExclude.join(', ')}`);
    if (c.recipients?.length) lines.push(`Sent to ${c.recipients.join(' or ')}`);
    if (c.cc?.length) lines.push(`CC includes ${c.cc.join(' or ')}`);
    if (c.subjectExact) lines.push(`Subject is exactly "${c.subjectExact}"`);
    if (c.subjectContains) lines.push(`Subject contains "${c.subjectContains}"`);
    if (c.subjectKeywords?.length) lines.push(`Subject has ${c.keywordMode === 'ALL' ? 'all' : 'any'} of: ${c.subjectKeywords.join(', ')}`);
    if (c.bodyContains) lines.push(`Body contains "${c.bodyContains}"`);
    if (c.range?.[0]) lines.push(`Received ${c.range[0].format('DD MMM YYYY')} – ${c.range[1]?.format('DD MMM YYYY')}`);
    if (!lines.length) lines.push('Every email with attachments');
    const a = values.attachments;
    lines.push(a?.mode === 'SELECTED' && a.extensions?.length ? `Save ${a.extensions.map((e) => e.toUpperCase()).join(', ')} files` : 'Save all attachment types');
    const d = values.download;
    if (d?.unlockProtected) lines.push('Remove passwords from PDF and ZIP files');
    if (d?.emailPdf === 'ALSO') lines.push('Also save the email itself as PDF');
    if (d?.emailPdf === 'ONLY') lines.push('Save only the email itself as PDF (no attachments)');
    if (a?.extractArchives || a?.extractEmails) lines.push(`Also look inside ${[a.extractArchives && 'ZIP files', a.extractEmails && 'attached emails'].filter(Boolean).join(' and ')}`);
    return lines;
  }, [values]);

  const insertToken = (field: 'subfolderPattern' | 'fileNamePattern' | 'emailPdfNamePattern', token: string) => {
    const cur = form.getFieldValue(['download', field]) ?? '';
    form.setFieldValue(['download', field], field === 'subfolderPattern' && cur && !cur.endsWith('\\') ? `${cur}\\${token}` : `${cur}${token}`);
  };

  return (
    <>
      <div className="mv-editor-bar">
        <Button icon={<ArrowLeftOutlined />} onClick={leave}>
          Back to rules
        </Button>
        <h1 className="mv-page-title mv-editor-title">{rule ? `Edit rule · ${rule.name}` : 'New download rule'}</h1>
        <Space>
          {rule && <Tag>v{rule.currentVersion}</Tag>}
          <Button onClick={leave}>Cancel</Button>
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
            {rule ? 'Save changes' : 'Create rule'}
          </Button>
        </Space>
      </div>
      <Row gutter={20}>
        <Col xs={24} lg={15}>
          <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} scrollToFirstError>
            <Section title="Basics" hint="Name the rule and choose which mailbox it watches.">
              <Row gutter={16}>
                <Col span={14}>
                  <Form.Item name="name" label="Rule name" rules={[{ required: true, min: 2, max: 120 }]}>
                    <Input placeholder="Vendor invoices" />
                  </Form.Item>
                </Col>
                <Col span={10}>
                  <Form.Item name="mailboxId" label="Email account" rules={[{ required: true, message: 'Choose a mailbox' }]}>
                    <Select placeholder="Select mailbox" options={(mailboxes.data ?? []).map((m) => ({ value: m.id, label: m.email }))} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item name="description" label="Description">
                    <Input.TextArea rows={2} maxLength={500} placeholder="What this rule collects and who uses the files" />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="priority" label="Priority" tooltip="Lower numbers run first (10 before 20).">
                    <InputNumber min={1} max={9999} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="enabled" label="Enabled" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="stopFurtherRules" label="Stop further rules" valuePropName="checked" tooltip="When this rule matches, lower-priority rules ignore the email.">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name="simulationMode" label="Simulation" valuePropName="checked" tooltip="Logs what it would download without saving files. Good for trying a new rule.">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
            </Section>

            <Section title="Which emails" hint="All filled-in conditions must match. Lists match if any entry matches. Use *@domain.com for a whole company.">
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name={['conditions', 'senderInclude']} label="From (sender)" rules={[addressRule]}>
                    <Select mode="tags" tokenSeparators={[',', ';', ' ']} placeholder="billing@vendor.com, *@vendor.com" open={false} suffixIcon={null} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['conditions', 'senderExclude']} label="Never from" rules={[addressRule]} tooltip="Excluded senders always win over the From list.">
                    <Select mode="tags" tokenSeparators={[',', ';', ' ']} placeholder="noreply@vendor.com" open={false} suffixIcon={null} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['conditions', 'recipients']} label="To (recipient)" rules={[addressRule]}>
                    <Select mode="tags" tokenSeparators={[',', ';', ' ']} placeholder="accounts@company.com" open={false} suffixIcon={null} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['conditions', 'cc']} label="CC" rules={[addressRule]}>
                    <Select mode="tags" tokenSeparators={[',', ';', ' ']} placeholder="finance@company.com" open={false} suffixIcon={null} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['conditions', 'subjectContains']} label="Subject contains">
                    <Input placeholder="Invoice" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['conditions', 'subjectExact']} label="Subject is exactly">
                    <Input placeholder="Monthly statement" />
                  </Form.Item>
                </Col>
                <Col span={16}>
                  <Form.Item name={['conditions', 'subjectKeywords']} label="Subject keywords">
                    <Select mode="tags" tokenSeparators={[',']} placeholder="invoice, bill, credit note" open={false} suffixIcon={null} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name={['conditions', 'keywordMode']} label="Keywords must match">
                    <Radio.Group optionType="button" options={[{ label: 'Any', value: 'ANY' }, { label: 'All', value: 'ALL' }]} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['conditions', 'bodyContains']} label="Email body contains" tooltip="Optional. The body is read only when every other condition already matched.">
                    <Input placeholder="GSTIN" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['conditions', 'range']} label="Received between" tooltip="Optional. Leave empty for all new emails.">
                    <DatePicker.RangePicker style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item name={['conditions', 'ignoreReplyPrefixes']} valuePropName="checked" label='Ignore "RE:" and "FW:" when comparing subjects' style={{ marginBottom: 0 }}>
                    <Switch size="small" />
                  </Form.Item>
                </Col>
              </Row>
            </Section>

            <Section title="Which attachments" hint="Inline images (like signature logos) and blocked file types are skipped automatically.">
              <Form.Item name={['attachments', 'mode']} label="Download">
                <Radio.Group
                  options={[
                    { label: 'All attachments', value: 'ALL' },
                    { label: 'Only selected file types', value: 'SELECTED' },
                  ]}
                />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(a, b) => a.attachments?.mode !== b.attachments?.mode}>
                {({ getFieldValue }) =>
                  getFieldValue(['attachments', 'mode']) === 'SELECTED' && (
                    <Form.Item name={['attachments', 'extensions']} label="File types" rules={[{ required: true, type: 'array', min: 1, message: 'Pick at least one file type' }]}>
                      <Select mode="tags" tokenSeparators={[',', ' ']} options={EXTENSIONS.map((e) => ({ value: e, label: e.toUpperCase() }))} placeholder="pdf, xlsx" />
                    </Form.Item>
                  )
                }
              </Form.Item>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name={['attachments', 'nameContains']} label="File name contains">
                    <Input placeholder="INV-" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['attachments', 'excludeNames']} label="Skip file names containing">
                    <Select mode="tags" tokenSeparators={[',']} placeholder="terms, brochure" open={false} suffixIcon={null} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name={['attachments', 'minSizeKb']} label="Min size (KB)">
                    <InputNumber min={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name={['attachments', 'maxSizeKb']} label="Max size (KB)">
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name={['attachments', 'allowMultiple']} label="Multiple per email" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item name={['attachments', 'includeInline']} label="Include inline images" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
              <Divider style={{ margin: '4px 0 16px' }} />
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name={['attachments', 'extractArchives']} label="Unpack ZIP files" valuePropName="checked" tooltip="Saves the files inside a .zip that match the file types and names above.">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name={['attachments', 'extractEmails']} label="Unpack attached emails" valuePropName="checked" tooltip="When an email is forwarded as an attachment (.eml/.msg), saves its attachments that match this rule.">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name={['attachments', 'keepContainer']} label="Also keep the ZIP / email" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
            </Section>

            <Section title="Where to save" hint="Folders are created automatically. Placeholders are filled from each email.">
              <Form.Item name={['download', 'destinationId']} label="Destination folder" rules={[{ required: true, message: 'Choose a destination folder' }]}>
                <Select
                  placeholder="Select a folder"
                  options={(destinations.data ?? []).map((d) => ({
                    value: d.id,
                    label: (
                      <Space>
                        <FolderOpenOutlined style={{ color: '#D97706' }} />
                        {d.name}
                        <span className="mv-mono mv-muted">{d.basePath}</span>
                        <DestinationStatusTag status={d.status} />
                      </Space>
                    ),
                  }))}
                />
              </Form.Item>
              <Form.Item
                name={['download', 'subfolderPattern']}
                label="Subfolder pattern"
                rules={[patternRule]}
                extra={<TokenBar onPick={(t) => insertToken('subfolderPattern', t)} />}
              >
                <Input className="mv-mono" placeholder="{SenderDomain}\{yyyy}\{MM}" />
              </Form.Item>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name={['download', 'senderSubfolders']} valuePropName="checked" label="Add a folder per sender" style={{ marginBottom: 8 }}>
                    <Switch size="small" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['download', 'dateSubfolders']} valuePropName="checked" label="Add year\month\day folders" style={{ marginBottom: 8 }}>
                    <Switch size="small" />
                  </Form.Item>
                </Col>
              </Row>
              <Divider style={{ margin: '12px 0 16px' }} />
              <Form.Item
                name={['download', 'fileNamePattern']}
                label="File name"
                rules={[patternRule]}
                tooltip="{OriginalName} alone keeps the attachment's name. The extension (.pdf, .zip …) is always added once at the end, so you don't need {Ext}."
                extra={<TokenBar forFileName onPick={(t) => insertToken('fileNamePattern', t)} />}
              >
                <Input className="mv-mono" placeholder="{BaseName}_{Date:dd-MM-yyyy}" />
              </Form.Item>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name={['download', 'duplicatePolicy']} label="If the file already exists">
                    <Select
                      options={[
                        { value: 'SMART', label: 'Smart: skip identical, rename different' },
                        { value: 'SKIP', label: 'Skip the new file' },
                        { value: 'REPLACE', label: 'Replace the existing file' },
                        { value: 'RENAME', label: 'Always keep both (rename)' },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['download', 'autoDownload']} label="Download automatically" valuePropName="checked" tooltip="Off: matches wait in History for someone to download them.">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name={['download', 'setFileDateToReceived']} label="Set file date to email date" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
            </Section>

            <Section title="Password-protected files" hint="MailVault can remove the password from PDF and ZIP attachments before saving them. The email in the mailbox is never changed.">
              <Form.Item name={['download', 'unlockProtected']} label="Remove passwords before saving" valuePropName="checked" style={{ marginBottom: 12 }}>
                <Switch />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(a, b) => a.download?.unlockProtected !== b.download?.unlockProtected}>
                {({ getFieldValue }) =>
                  getFieldValue(['download', 'unlockProtected']) && (
                    <>
                      <PasswordList saved={rule?.filePasswordCount ?? 0} value={passwords} onChange={setPasswords} />
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginTop: 12 }}
                        message="How it works"
                        description={
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            <li>PDFs are saved without their password; PDFs that only block printing or copying are freed too.</li>
                            <li>ZIPs are saved as the same ZIP without a password. PDFs inside are unlocked with the same passwords.</li>
                            <li>The passwords are tried in order. If none works, the file is saved with its password, History shows it, and an alert is sent. Fix the password, then use <b>Retry</b> in Download History.</li>
                          </ul>
                        }
                      />
                      <Alert type="warning" showIcon style={{ marginTop: 10 }} message="Unlocked files can be opened by anyone who can open the destination folder. Check the folder's Windows permissions." />
                    </>
                  )
                }
              </Form.Item>
            </Section>

            <Section title="Save the email as PDF" hint="Saves the email itself (sender, recipients, date, subject and the message) as a PDF next to the attachments.">
              <Form.Item name={['download', 'emailPdf']} label="Email PDF" style={{ marginBottom: 12 }}>
                <Radio.Group
                  options={[
                    { label: 'Off', value: 'OFF' },
                    { label: 'Also save the email as PDF', value: 'ALSO' },
                    { label: 'Only the email PDF (no attachments)', value: 'ONLY' },
                  ]}
                />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(a, b) => a.download?.emailPdf !== b.download?.emailPdf}>
                {({ getFieldValue }) =>
                  getFieldValue(['download', 'emailPdf']) !== 'OFF' && (
                    <>
                      <Form.Item
                        name={['download', 'emailPdfNamePattern']}
                        label="PDF file name"
                        rules={[patternRule]}
                        tooltip=".pdf is added automatically. {OriginalName} / {BaseName} stand for the email subject here."
                        extra={<TokenBar onPick={(t) => insertToken('emailPdfNamePattern', t)} />}
                      >
                        <Input className="mv-mono" placeholder="{yyyyMMdd}_{Subject}" />
                      </Form.Item>
                      <Form.Item
                        name={['download', 'emailPdfRemoteImages']}
                        label="Load pictures from the internet"
                        valuePropName="checked"
                        tooltip="Off (recommended): only pictures embedded in the email are shown. Loading internet pictures tells the sender the email was opened, and makes the server fetch addresses chosen by the sender."
                        style={{ marginBottom: 0 }}
                      >
                        <Switch />
                      </Form.Item>
                    </>
                  )
                }
              </Form.Item>
            </Section>
          </Form>
        </Col>

        <Col xs={24} lg={9}>
          <div className="mv-editor-side">
            <Card className="mv-card" size="small" title={<Space><BulbOutlined style={{ color: '#3C2E7E' }} />Rule summary</Space>} styles={{ body: { padding: 18 } }}>
              <ul style={{ paddingLeft: 18, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {summary.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {values?.simulationMode && (
                <Alert style={{ marginTop: 14 }} type="info" showIcon icon={<ExperimentOutlined />} message="Simulation mode: nothing is saved, History shows what would happen." />
              )}
              {values?.stopFurtherRules && <Alert style={{ marginTop: 10 }} type="warning" showIcon message="Lower-priority rules will skip emails this rule matches." />}
              <Button block icon={<ExperimentOutlined />} style={{ marginTop: 14 }} loading={test.isPending} onClick={() => test.mutate()}>
                Test on the last 14 days of email
              </Button>
            </Card>

            <Card className="mv-card" size="small" style={{ marginTop: 16 }} title={<Space><FolderOpenOutlined style={{ color: '#D97706' }} />Example save location</Space>} styles={{ body: { padding: 18 } }}>
              {preview ? (
                <>
                  <div className="mv-muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
                    For an email from <b>{preview.sample}</b> received today:
                  </div>
                  <div className="mv-mono" style={{ background: '#F8FAFC', border: '1px solid #E6E9F0', borderRadius: 8, padding: 12, wordBreak: 'break-all', lineHeight: 1.6 }}>
                    {!preview.onlyEmailPdf && (
                      <div>
                        <span className="mv-muted">{preview.folder}\</span>
                        <b>{preview.file}</b>
                      </div>
                    )}
                    {preview.emailPdf && (
                      <div style={{ marginTop: preview.onlyEmailPdf ? 0 : 6 }}>
                        <span className="mv-muted">{preview.folder}\</span>
                        <b>{preview.emailPdf}</b> <Tag color="purple">email PDF</Tag>
                      </div>
                    )}
                  </div>
                  {preview.dest?.status === 'UNAVAILABLE' && <Alert style={{ marginTop: 10 }} type="error" showIcon message="This destination folder is currently unavailable." />}
                </>
              ) : (
                <span className="mv-muted">Choose a destination to see the path.</span>
              )}
            </Card>

            <Card className="mv-card" size="small" style={{ marginTop: 16 }} styles={{ body: { padding: 16 } }}>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                <InfoCircleOutlined /> Rules apply to emails received after they are created. Editing a rule saves a new version; emails
                already processed keep the version that matched them. Use a historical job (Phase 2) to process older mail.
              </Typography.Text>
            </Card>
          </div>
        </Col>
      </Row>
      <Modal
        open={testOpen}
        onCancel={() => setTestOpen(false)}
        footer={null}
        width={900}
        title={test.data ? `Test result: ${draftMatches.length} of ${test.data.emails.length} recent email(s) match` : 'Testing the rule…'}
        destroyOnHidden
      >
        {test.isPending ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : test.isError ? (
          <Alert type="error" showIcon message={(test.error as Error).message} />
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="Emails from the last 14 days that this unsaved rule would pick up. Nothing is downloaded from this window."
            />
            <TestResults emails={draftMatches} mailboxId={values?.mailboxId ?? ''} canDownload={false} />
          </>
        )}
      </Modal>
    </>
  );
}

/**
 * Saved passwords are never shown: the rule only says how many are set. Typing new ones replaces them all.
 * value: null = keep the saved passwords, [] = remove them, list = replace them.
 */
function PasswordList({ saved, value, onChange }: { saved: number; value: string[] | null; onChange: (v: string[] | null) => void }) {
  if (value === null) {
    return (
      <Space wrap>
        {saved > 0 ? (
          <Tag icon={<LockOutlined />} color="green" style={{ padding: '3px 10px', fontSize: 13 }}>
            {saved} password{saved === 1 ? '' : 's'} saved
          </Tag>
        ) : (
          <Tag icon={<LockOutlined />} style={{ padding: '3px 10px', fontSize: 13 }}>No password saved yet</Tag>
        )}
        <Button size="small" icon={<KeyOutlined />} onClick={() => onChange([''])}>
          {saved ? 'Replace passwords' : 'Add passwords'}
        </Button>
        {saved > 0 && (
          <Button size="small" danger onClick={() => onChange([])}>
            Remove passwords
          </Button>
        )}
      </Space>
    );
  }
  if (value.length === 0) {
    return (
      <Space>
        <Typography.Text type="danger">The saved passwords will be removed when you save the rule.</Typography.Text>
        <Button size="small" onClick={() => onChange(null)}>
          Undo
        </Button>
      </Space>
    );
  }
  const set = (i: number, v: string) => onChange(value.map((p, j) => (j === i ? v : p)));
  return (
    <div style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
        Tried in this order. Keep the old password here for a while when a sender changes it.{saved ? ' Saving replaces the passwords saved before.' : ''}
      </Typography.Text>
      {value.map((p, i) => (
        <Space.Compact key={i} style={{ width: '100%' }}>
          <Input.Password value={p} onChange={(e) => set(i, e.target.value)} placeholder={`Password ${i + 1}`} autoComplete="new-password" maxLength={200} />
          <Button icon={<DeleteOutlined />} aria-label="Remove this password" onClick={() => onChange(value.length === 1 ? (saved ? null : []) : value.filter((_, j) => j !== i))} />
        </Space.Compact>
      ))}
      <Space>
        {value.length < 5 && (
          <Button size="small" icon={<PlusOutlined />} onClick={() => onChange([...value, ''])}>
            Add another
          </Button>
        )}
        <Button size="small" type="link" onClick={() => onChange(null)}>
          {saved ? 'Keep the saved passwords' : 'Cancel'}
        </Button>
      </Space>
    </div>
  );
}

/** Form rule: flags typos such as {yyy} or {Date:dd/MM} that would otherwise stay in the name as text. */
const patternRule = {
  validator: async (_: unknown, v?: string) => {
    const bad = v ? unknownTokens(v) : [];
    if (bad.length) throw new Error(`Unknown placeholder ${bad.join(', ')}. Click a tag below to insert a valid one.`);
  },
};

const FILE_TOKENS: PatternToken[] = ['{OriginalName}', '{BaseName}', '{Ext}'];
const tagStyle = { cursor: 'pointer', fontFamily: 'Consolas, monospace', fontSize: 11.5, marginInlineEnd: 0 } as const;
const EXAMPLE_DATE = new Date('2026-04-07T14:30:05+05:30');

function TokenGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <span className="mv-muted" style={{ fontSize: 12, width: 110, flex: 'none' }}>{label}</span>
      {children}
    </div>
  );
}

function TokenBar({ onPick, forFileName }: { onPick: (t: string) => void; forFileName?: boolean }) {
  const token = (t: string, help: string) => (
    <Tooltip key={t} title={`${help} · click to add`}>
      <Tag style={tagStyle} onClick={() => onPick(t)}>{t}</Tag>
    </Tooltip>
  );
  const dateTag = (kind: 'Date' | 'Today', f: string) =>
    token(`{${kind}:${f}}`, `${kind === 'Date' ? 'Email received date' : 'Date the file is saved'}: ${formatDate(EXAMPLE_DATE, f, 'Asia/Kolkata')}`);
  const simple = PATTERN_TOKENS.filter((t) => !FILE_TOKENS.includes(t) && t !== '{Today}');
  const dateTokens = simple.slice(0, simple.indexOf('{SenderEmail}'));
  const emailTokens = simple.slice(simple.indexOf('{SenderEmail}'));
  return (
    <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
      {forFileName && <TokenGroup label="Attachment">{FILE_TOKENS.map((t) => token(t, PATTERN_TOKEN_HELP[t]))}</TokenGroup>}
      <TokenGroup label="Email date">
        {dateTokens.map((t) => token(t, PATTERN_TOKEN_HELP[t]))}
        {forFileName && DATE_FORMAT_PRESETS.map((f) => dateTag('Date', f))}
      </TokenGroup>
      {forFileName && (
        <TokenGroup label="Today (saved)">
          {token('{Today}', PATTERN_TOKEN_HELP['{Today}'])}
          {DATE_FORMAT_PRESETS.slice(0, 5).map((f) => dateTag('Today', f))}
        </TokenGroup>
      )}
      <TokenGroup label="Email">{emailTokens.map((t) => token(t, PATTERN_TOKEN_HELP[t]))}</TokenGroup>
      <div className="mv-muted" style={{ fontSize: 12 }}>
        Your own date format: <span className="mv-mono">{'{Date:dd-MM-yyyy}'}</span> (email date) or{' '}
        <span className="mv-mono">{'{Today:dd-MM-yyyy}'}</span> (save date), using {DATE_FORMAT_PARTS_HELP} and - _ . space , as separators.
      </div>
    </div>
  );
}
