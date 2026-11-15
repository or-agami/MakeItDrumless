import { Disc3, Headphones, Library, Settings2 } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router";

export function AppShell() {
  const location = useLocation();
  const isPlayback = location.pathname.startsWith("/play/");
  return (
    <div className="app-frame dark">
      <aside className="app-sidebar">
        <div className="brand-mark"><Disc3 size={20} strokeWidth={1.8} /></div>
        <div className="brand-name"><span>MAKE IT</span><strong>DRUMLESS</strong></div>
        <div className="sidebar-rule" />
        <NavLink to="/" className={({ isActive }) => `nav-item ${isActive && !isPlayback ? "active" : ""}`}>
          <Library size={18} /><span>Library</span>
        </NavLink>
        <div className="sidebar-spacer" />
        <div className="sidebar-caption">PRACTICE PLAYER</div>
        <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
          <Settings2 size={18} /><span>Settings</span>
        </NavLink>
        <div className="sidebar-footer"><span className="online-dot" /> Local library</div>
      </aside>
      <main className="app-main"><Outlet /></main>
      <div className="mobile-brand"><Headphones size={17} /> MakeItDrumless</div>
    </div>
  );
}
