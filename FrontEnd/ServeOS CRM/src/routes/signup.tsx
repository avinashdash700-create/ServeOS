import { createFileRoute } from "@tanstack/react-router";
import { AuthShell } from "./login";

export const Route = createFileRoute("/signup")({
  head: () => ({ meta: [{ title: "Sign up — ServeOS" }] }),
  component: () => <AuthShell mode="signup" />,
});
