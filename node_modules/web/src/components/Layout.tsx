import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { logout } from '../lib/api';

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, reload } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    reload();
    navigate('/login');
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <Link to="/dashboard" className="logo">
            <span className="logo-ut">UT</span>
            <span className="logo-text">Athletics Insurance</span>
          </Link>
          {user && (
            <nav className="nav">
              <Link to="/dashboard">Dashboard</Link>
              {user.role === 'coach' && <Link to="/request/new">New Request</Link>}
              {(user.role === 'cfo') && <Link to="/admin/sports">Manage Sports</Link>}
              {user.role === 'cfo' && <Link to="/reports">Reports</Link>}
              <span className="nav-user">{user.displayName}</span>
              <button className="btn btn-sm btn-outline" onClick={handleLogout}>Sign Out</button>
            </nav>
          )}
        </div>
      </header>
      <main className="main">{children}</main>
      <footer className="footer">
        University of Toledo Athletics — Business Office &nbsp;|&nbsp; Anthem Student Advantage
      </footer>
    </div>
  );
}
