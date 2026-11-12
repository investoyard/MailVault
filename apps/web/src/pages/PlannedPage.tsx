import { Card, Tag } from 'antd';
import { CheckCircleOutlined, RocketOutlined } from '@ant-design/icons';
import { PageHeader } from '../components/ui';

export function PlannedPage({ title, phase, description, points }: { title: string; phase: string; description: string; points: string[] }) {
  return (
    <>
      <PageHeader title={title} subtitle={description} extra={<Tag color="purple" icon={<RocketOutlined />}>Planned for {phase}</Tag>} />
      <Card className="mv-card">
        <div style={{ maxWidth: 640, margin: '24px auto', textAlign: 'center' }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: '#EEF2FF', color: '#4F46E5', display: 'grid', placeItems: 'center', fontSize: 24, margin: '0 auto 16px' }}>
            <RocketOutlined />
          </div>
          <div style={{ fontSize: 18, fontWeight: 650, marginBottom: 6 }}>{title} is on the way</div>
          <div className="mv-muted" style={{ marginBottom: 24 }}>This screen will let you:</div>
          <div style={{ textAlign: 'left', display: 'inline-flex', flexDirection: 'column', gap: 12 }}>
            {points.map((p) => (
              <div key={p} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <CheckCircleOutlined style={{ color: '#16A34A', marginTop: 4 }} />
                <span>{p}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}
