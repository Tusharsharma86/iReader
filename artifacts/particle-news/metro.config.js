const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch workspace packages that live outside the project root
config.watchFolders = [workspaceRoot];

// Resolve modules from both the project and the workspace root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Required so Metro uses the `exports` field in workspace package.json files
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
