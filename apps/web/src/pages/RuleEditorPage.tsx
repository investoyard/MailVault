import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Skeleton } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { api } from '../api';
import { RuleEditor, type RuleRecord } from '../components/RuleEditor';

/** /rules/new and /rules/:id — the rule editor as a full page (Back returns to the rules list). */
export function RuleEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const back = () => navigate('/rules');
  const isNew = !id || id === 'new';
  const q = useQuery({
    queryKey: ['rule', id],
    queryFn: () => api.get<RuleRecord>(`/api/rules/${id}`),
    enabled: !isNew,
    // Always load the latest version when the page opens; the form is filled once, so no refetch while editing.
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  if (isNew) return <RuleEditor key="new" rule={null} onDone={back} />;
  if (q.isError) {
    return (
      <>
        <Button icon={<ArrowLeftOutlined />} onClick={back} style={{ marginBottom: 16 }}>
          Back to rules
        </Button>
        <Alert type="error" showIcon message="This rule could not be opened" description={(q.error as Error).message} />
      </>
    );
  }
  if (!q.data) return <Skeleton active paragraph={{ rows: 12 }} />;
  return <RuleEditor key={q.data.id} rule={q.data} onDone={back} />;
}
