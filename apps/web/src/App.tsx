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
import { SyncHistoryPage } from './pages/SyncHistoryPage';
import { UsersPage } from './pages/UsersPage';
import { SettingsPage } from './pages/SettingsPage';
import { SystemStatusPage } from './pages/SystemStatusPage';
import { RuleTestingPage } from './pages/RuleTestingPage';
import { HistoricalJobsPage } from './pages/HistoricalJobsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';

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
        <Route path="rule-testing" element={<RuleTestingPage />} />
        <Route path="historical-jobs" element={<HistoricalJobsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="destinations" element={<DestinationsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="sync-history" element={<SyncHistoryPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="system" element={<SystemStatusPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
