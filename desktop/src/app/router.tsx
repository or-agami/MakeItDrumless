import { createBrowserRouter, RouterProvider } from "react-router";
import { AppShell } from "@/features/shell/app-shell";

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, lazy: () => import("@/features/library/page") },
      { path: "generate", lazy: () => import("@/features/generate/page") },
      { path: "play/:itemId", lazy: () => import("@/features/playback/page") },
      { path: "settings", lazy: () => import("@/features/settings/page") },
    ],
  },
]);

export default function AppRouter() {
  return <RouterProvider router={router} />;
}
