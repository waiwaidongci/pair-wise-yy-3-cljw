import http from "node:http";
import { handleApi, renderPage } from "./src/routes.js";

const port = Number(process.env.PORT || 3025);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderPage());
    }
    const handled = await handleApi(req, res, url);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "not_found" }));
    }
  } catch (error) {
    const status = error.code && Number.isInteger(error.code) ? error.code : 500;
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      const payload = { error: error.message || "internal_error" };
      if (error.blockers) payload.blockers = error.blockers;
      res.end(JSON.stringify(payload));
    }
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
