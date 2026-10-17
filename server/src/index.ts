import { createGameServer } from './server.js';
import { pathToFileURL } from 'node:url';
export { createGameServer } from './server.js';
export { Game } from './game.js';
export { readConfig } from './config.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createGameServer();
  app.listen().then(address => console.log(`Tank Front: listening on ${address.address}:${address.port}`)).catch(error => {
    console.error('Не удалось запустить сервер:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    void app.close();
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void app.close().then(() => { process.exitCode = 0; });
    });
  }
}
