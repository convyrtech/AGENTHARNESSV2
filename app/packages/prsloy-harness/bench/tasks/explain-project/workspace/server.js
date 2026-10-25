const http = require("node:http");
const { saveOrder } = require("./orders.js");
const { notifyManager } = require("./mail.js");

const PORT = 8081;

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/order") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const order = JSON.parse(body);
        saveOrder(order);
        notifyManager(order);
        res.end("Спасибо за заказ!");
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(PORT);
