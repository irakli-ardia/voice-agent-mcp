import { describeDataDirPolicy } from "../../helpers/data-dir-scenarios.js";

// The compiled server, plain node: the same scenarios as tests/integration/mcp-data-dir-policy.test.ts.
describeDataDirPolicy("built distribution", true);
