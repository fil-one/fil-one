import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./aurora-backoffice.swagger.json",
  output: {
    path: "./src/generated",
    importFileExtension: ".ts",
  },
});
