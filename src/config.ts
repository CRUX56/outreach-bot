import "dotenv/config";

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://outreach:outreach@localhost:5432/outreach",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1:8b",
  appSecret: process.env.APP_SECRET ?? "",
  adminUser: process.env.ADMIN_USER ?? "admin",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  port: Number(process.env.PORT ?? 3000),
  placesKey: process.env.GOOGLE_PLACES_API_KEY ?? "",
};
