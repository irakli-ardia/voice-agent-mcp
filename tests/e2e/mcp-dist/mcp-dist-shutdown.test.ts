import { describeBoundedShutdown } from "../../helpers/shutdown-scenarios.js";

// The compiled server, plain node: the same scenarios as tests/integration/mcp-stdio-shutdown.test.ts.
describeBoundedShutdown("built distribution", true);
