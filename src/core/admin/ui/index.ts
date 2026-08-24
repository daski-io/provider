import { Router } from "express";
import { mountAdminAuthRoutes } from "./authRoutes.js";
import { mountServicesPages } from "./pages/services.js";
import { mountConfigPage } from "./pages/config.js";
import { mountLogPage } from "./pages/log.js";
import { mountEmailsPage } from "./pages/emails.js";
import { mountTransactionsPages } from "./pages/transactions.js";
import { mountCustomersPages } from "./pages/customers.js";
import { mountReviewsPages } from "./pages/reviews.js";
import { mountChatPage } from "./pages/chat.js";

export const adminUiRouter = Router();

adminUiRouter.get("/", (_req, res) => res.redirect("/admin/ui/services"));
mountAdminAuthRoutes(adminUiRouter);
mountServicesPages(adminUiRouter);
mountTransactionsPages(adminUiRouter);
mountCustomersPages(adminUiRouter);
mountReviewsPages(adminUiRouter);
mountChatPage(adminUiRouter);
mountConfigPage(adminUiRouter);
mountLogPage(adminUiRouter);
mountEmailsPage(adminUiRouter);

// Terminal 404 for unmatched /admin/ui/* paths. Without it they fall
// through to the bearer-token /admin middleware, which answers a signed-in
// browser with {"error":"unauthorized"} instead of a not-found page.
adminUiRouter.use((_req, res) => {
  res.status(404).type("html").send("Not found");
});
