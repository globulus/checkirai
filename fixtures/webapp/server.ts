import http from "node:http";

const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Fixture App</title></head>
  <body>
    <h1>Fixture App</h1>
    <button id="sign-in">Sign in</button>
    <div id="msg" aria-live="polite"></div>
    <script>
      document.getElementById('sign-in').addEventListener('click', () => {
        document.getElementById('msg').textContent = 'Clicked Sign in';
      });
    </script>
  </body>
</html>`;

export function startFixtureServer(
  port = 31337,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
