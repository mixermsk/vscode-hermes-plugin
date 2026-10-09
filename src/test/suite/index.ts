import * as path from 'node:path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    color: true,
    ui: 'tdd'
  });
  mocha.addFile(path.resolve(__dirname, '../integration/extension.test.js'));

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures === 0) {
        resolve();
        return;
      }

      reject(new Error(`${failures} test(s) failed.`));
    });
  });
}
