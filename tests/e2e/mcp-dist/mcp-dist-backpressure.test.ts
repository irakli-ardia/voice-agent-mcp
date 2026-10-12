import { describeStdoutBackpressure } from "../../helpers/backpressure-scenarios.js";

// The compiled server, plain node: the same scenarios as tests/integration/mcp-stdio-backpressure.test.ts.
describeStdoutBackpressure("built distribution", true);
