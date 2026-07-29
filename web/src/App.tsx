import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { AuthContext } from './lib/auth';
import { getMe, selectIdentity as apiSelectIdentity, login as apiLogin, logout as apiLogout } from './lib/api';
import type { User } from './types';

import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { Setup } from './pages/Setup';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { ChangePassword } from './pages/ChangePassword';
import { NotFound } from './pages/NotFound';
import { Dashboard } from './pages/Dashboard';
import { NewRequest } from './pages/request/New';
import { RequestDetail } from './pages/request/Detail';
import { Reports } from './pages/Reports';
import { AuditLog } from './pages/AuditLog';
import { AdminUsers } from './pages/admin/Users';
import { AdminSports } from './pages/admin/Sports';
import { AdminSettingsPage } from './pages/admin/Settings';
import { SessionTimeout } from './components/SessionTimeout';
import { ErrorBoundary } from './components/ErrorBoundary';

function Nav({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Close the mobile menu whenever the route changes
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const isAdmin = user.role === 'cfo' || user.role === 'super_admin';
  // Mark the current section so users can see where they are.
  const cls = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`)
      ? 'navbar-link navbar-link--active'
      : 'navbar-link';

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <Link to="/dashboard">
          <img src="/logo-dark.png" alt="University of Toledo Athletics" style={{ height: '36px', verticalAlign: 'middle' }} />
        </Link>
      </div>

      {/* Hamburger — visible only on mobile via CSS */}
      <button
        className={`navbar-hamburger${menuOpen ? ' navbar-hamburger--open' : ''}`}
        onClick={() => setMenuOpen(o => !o)}
        aria-label="Toggle navigation menu"
        aria-expanded={menuOpen}
        aria-controls="navbar-menu"
      >
        <span />
        <span />
        <span />
      </button>

      <div
        id="navbar-menu"
        className={`navbar-links${menuOpen ? ' navbar-links--open' : ''}`}
      >
        <Link className={cls('/dashboard')} to="/dashboard">Dashboard</Link>
        {user.role === 'coach' && <Link className={cls('/request/new')} to="/request/new">New Request</Link>}
        {isAdmin && <Link className={cls('/reports')} to="/reports">Reports</Link>}
        {isAdmin && <Link className={cls('/audit')} to="/audit">Audit Log</Link>}
        {isAdmin && <Link className={cls('/admin/users')} to="/admin/users">Users</Link>}
        {user.role === 'super_admin' && <Link className={cls('/admin/sports')} to="/admin/sports">Sports &amp; Coaches</Link>}
        {user.role === 'super_admin' && <Link className={cls('/admin/settings')} to="/admin/settings">Settings</Link>}

        {/* Mobile-only: user identity + sign-out inside open drawer */}
        <div className="navbar-mobile-user">
          <span className="navbar-name">{user.name}</span>
          <span className="badge">{user.role.replace(/_/g, ' ')}</span>
          <button className="btn-logout" onClick={onLogout}>Sign Out</button>
        </div>
      </div>

      {/* Desktop user strip — hidden on mobile via CSS */}
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
  const location = useLocation();

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

  // Accounts created by an admin get a temporary password and must replace it before
  // doing anything else. The page for this existed but was never routed, so every
  // admin-issued password stayed valid indefinitely.
  const mustChangePassword = !!user?.mustChangePassword;
  if (mustChangePassword && location.pathname !== '/change-password') {
    return (
      <AuthContext.Provider value={{ user, loading, selectIdentity, login, logout, refresh }}>
        <Navigate to="/change-password" replace />
      </AuthContext.Provider>
    );
  }

  const requireAuth = (element: React.ReactElement) =>
    user ? element : <Navigate to="/login" replace />;

  return (
    <AuthContext.Provider value={{ user, loading, selectIdentity, login, logout, refresh }}>
      {user && !mustChangePassword && <Nav user={user} onLogout={logout} />}
      {user && <SessionTimeout onTimeout={logout} />}
      <main className="main-content">
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
          <Route path="/setup" element={user ? <Navigate to="/dashboard" replace /> : <Setup />} />
          <Route path="/register" element={user ? <Navigate to="/dashboard" replace /> : <Register />} />
          <Route path="/forgot-password" element={user ? <Navigate to="/dashboard" replace /> : <ForgotPassword />} />
          {/* Renders even with a session: a signed-in user following a reset link from
              their inbox was previously bounced straight to the dashboard. */}
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/change-password" element={requireAuth(<ChangePassword />)} />
          <Route path="/dashboard" element={requireAuth(<Dashboard />)} />
          <Route path="/request/new" element={requireAuth(<NewRequest />)} />
          <Route path="/request/:id" element={requireAuth(<RequestDetail />)} />
          <Route path="/reports" element={requireAuth(<Reports />)} />
          <Route path="/audit" element={requireAuth(<AuditLog />)} />
          <Route path="/admin/users" element={requireAuth(<AdminUsers />)} />
          <Route path="/admin/sports" element={requireAuth(<AdminSports />)} />
          <Route path="/admin/settings" element={requireAuth(<AdminSettingsPage />)} />
          <Route path="/" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
          <Route path="*" element={<NotFound signedIn={!!user} />} />
        </Routes>
      </main>
    </AuthContext.Provider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppLayout />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
