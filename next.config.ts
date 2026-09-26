import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The MongoDB driver has optional native deps; keep it out of the bundle.
  serverExternalPackages: ["mongodb"],
  // Don't write AGENTS.md / CLAUDE.md into the project when run by a coding assistant.
  agentRules: false,
};

export default withWorkflow(nextConfig);
