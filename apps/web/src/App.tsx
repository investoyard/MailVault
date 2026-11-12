import { Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth } from './auth';
import { AppLayout } from './layout/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { AccountsPage } from './pages/AccountsPage';
import { RulesPage } from './pages/RulesPage';
import { HistoryPage } from './pages/HistoryPage';
import { DestinationsPage } from './pages/DestinationsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { LogsPage } from './pages/LogsPage';
import { UsersPage } from './pages/UsersPage';
import { SettingsPage } from './pages/SettingsPage';
import { SystemStatusPage } from './pages/SystemStatusPage';
import { PlannedPage } from './pages/PlannedPage';

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="full-center">
        <Spin size="large" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="rules" element={<RulesPage />} />
        <Route
          path="rule-testing"
          element={
            <PlannedPage
              title="Rule Testing"
              phase="Phase 2"
              description="Try rules against real emails before they go live."
              points={[
                'Pick a mailbox, sender, subject keywords and a date range',
                'Preview matching emails and their attachments',
                'See which rules match each email, with a ✔/✘ for every condition',
                'Download selected attachments manually',
                'Run a rule against historical emails',
              ]}
            />
          }
        />
        <Route
          path="historical-jobs"
          element={
            <PlannedPage
              title="Historical Jobs"
              phase="Phase 2"
              description="Process older emails on purpose, never by accident."
              points={[
                'Choose mailbox, folders, date range and rules',
                'Simulate first ("would download X to Y") or execute',
                'Optionally include emails that were already processed',
                'Live progress, cancel and resume',
                'Runs at lower priority so live sync is never delayed',
              ]}
            />
          }
        />
        <Route path="history" element={<HistoryPage />} />
        <Route path="destinations" element={<DestinationsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="system" element={<SystemStatusPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
