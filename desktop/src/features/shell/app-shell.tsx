import { Disc3, Headphones, Library, Settings2 } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router";
import { PlaybackPage } from "@/features/playback/page";

export function AppShell() {
  const location = useLocation();
  const isPlayback = location.pathname === "/play" || location.pathname.startsWith("/play/");
  const encodedItemId = isPlayback ? location.pathname.slice("/play/".length) : "";
  let itemId = "";
  try { itemId = decodeURIComponent(encodedItemId); } catch { itemId = encodedItemId; }
  return (
    <div className="app-frame dark">
      <aside className="app-sidebar">
        <div className="brand-mark"><Disc3 size={20} strokeWidth={1.8} /></div>
        <div className="brand-name"><span>MAKE IT</span><strong>DRUMLESS</strong></div>
        <div className="sidebar-rule" />
        <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive && !isPlayback ? "active" : ""}`}>
          <Library size={18} /><span>Library</span>
        </NavLink>
        <NavLink to="/play" className={() => `nav-item ${isPlayback ? "active" : ""}`}>
          <Headphones size={18} /><span>Player</span>
        </NavLink>
        <div className="sidebar-spacer" />
        <div className="sidebar-caption">PRACTICE PLAYER</div>
        <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
          <Settings2 size={18} /><span>Settings</span>
        </NavLink>
        <div className="sidebar-footer"><span className="online-dot" /> Local library</div>
      </aside>
      <main className="app-main">
        <div className={`route-view ${isPlayback ? "route-view-hidden" : ""}`} aria-hidden={isPlayback}>
          <Outlet />
        </div>
        <div className={`playback-view ${isPlayback ? "playback-view-active" : ""}`} aria-hidden={!isPlayback} inert={!isPlayback}>
          <PlaybackPage itemId={itemId} isVisible={isPlayback} />
        </div>
      </main>
      <div className="mobile-brand"><Headphones size={17} /> MakeItDrumless</div>
    </div>
  );
}
