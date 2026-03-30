import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { NewRequest } from './pages/request/New';
import { RequestDetail } from './pages/request/Detail';
import { AdminSports } from './pages/admin/Sports';
import { Reports } from './pages/Reports';
import './index.css';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-center">Loading…</div>;
  if (!user)   return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/"             element={<Navigate to="/dashboard" replace />} />
      <Route path="/login"        element={<Login />} />

      <Route path="/dashboard"    element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/request/new"  element={<ProtectedRoute><NewRequest /></ProtectedRoute>} />
      <Route path="/request/:id"  element={<ProtectedRoute><RequestDetail /></ProtectedRoute>} />
      <Route path="/admin/sports" element={<ProtectedRoute><AdminSports /></ProtectedRoute>} />
      <Route path="/reports"      element={<ProtectedRoute><Reports /></ProtectedRoute>} />

      <Route path="*"             element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}

