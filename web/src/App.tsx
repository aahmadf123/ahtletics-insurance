import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { AuthContext } from './lib/auth';
import { getMe, selectIdentity as apiSelectIdentity, login as apiLogin, logout as apiLogout } from './lib/api';
import type { User } from './types';

import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { Dashboard } from './pages/Dashboard';
import { NewRequest } from './pages/request/New';
import { RequestDetail } from './pages/request/Detail';
import { Reports } from './pages/Reports';
import { AdminUsers } from './pages/admin/Users';

function Nav({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <Link to="/dashboard">Athletics Insurance</Link>
      </div>
      <div className="navbar-links">
        <Link to="/dashboard">Dashboard</Link>
        {user.role === 'coach' && <Link to="/request/new">New Request</Link>}
        {(user.role === 'cfo' || user.role === 'super_admin') && <Link to="/reports">Reports</Link>}
        {(user.role === 'cfo' || user.role === 'super_admin') && <Link to="/admin/users">Users</Link>}
      </div>
      <div className="navbar-user">
        <span className="navbar-name">{user.name}</span>
        <span className="badge">{user.role.replace(/_/g, ' ')}</span>
        <button className="btn-logout" onClick={onLogout}>Sign Out</button>
      </div>
    </nav>
  );
}

function AppLayout() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const u = await getMe();
      setUser(u);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const selectIdentity = async (role: string) => {
    const u = await apiSelectIdentity(role);
    setUser(u);
  };

  const login = async (email: string, password: string) => {
    const u = await apiLogin(email, password);
    setUser(u);
  };

  const logout = async () => {
    await apiLogout().catch(() => {});
    setUser(null);
    navigate('/login');
  };

  if (loading) return <div className="loading-screen"><p>Loading…</p></div>;

  return (
    <AuthContext.Provider value={{ user, loading, selectIdentity, login, logout, refresh }}>
      {user && <Nav user={user} onLogout={logout} />}
      <main className="main-content">
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
          <Route path="/register" element={user ? <Navigate to="/dashboard" replace /> : <Register />} />
          <Route path="/dashboard" element={
            !user ? <Navigate to="/login" replace /> : <Dashboard />
          } />
          <Route path="/request/new" element={
            !user ? <Navigate to="/login" replace /> : <NewRequest />
          } />
          <Route path="/request/:id" element={
            !user ? <Navigate to="/login" replace /> : <RequestDetail />
          } />
          <Route path="/reports" element={
            !user ? <Navigate to="/login" replace /> : <Reports />
          } />
          <Route path="/admin/users" element={
            !user ? <Navigate to="/login" replace /> : <AdminUsers />
          } />
          <Route path="/" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
          <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
        </Routes>
      </main>
    </AuthContext.Provider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}
