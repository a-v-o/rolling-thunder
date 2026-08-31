import { Agenda } from "agenda";
import { MongoBackend } from "@agendajs/mongo-backend";

export const agenda = new Agenda({
  backend: new MongoBackend({
    address: process.env.MONGODB_URI,
    collection: "agendaJobs",
  }),
  processEvery: "15 seconds",
  removeOnComplete: true,
});
