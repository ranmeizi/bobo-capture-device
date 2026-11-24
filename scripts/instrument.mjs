import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://fe0a021f98c17d74554f87a6a133e817@o4512451653009408.ingest.us.sentry.io/4512463576760320",
  environment: process.env.NODE_ENV || "development",
  serverName: "bobo-cap",
  initialScope: {
    tags: { service: "bobo-cap" },
  },
});