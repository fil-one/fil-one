import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./src/aurora-backoffice-client/aurora-backoffice.swagger.json",
  output: "./src/aurora-backoffice-client/generated",
  plugins: ["@hey-api/client-fetch"],
});
