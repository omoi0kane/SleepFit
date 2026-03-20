import { mkdirp } from 'mkdirp';
import copy from 'recursive-copy';
import { rimraf } from 'rimraf';

async function main() {
  const webSourceDirectory = 'src-overlay-ui/build';
  const webTargetDirectory = 'src-core/resources/dotnet-sidecars/ui';
  await rimraf(webTargetDirectory);
  await mkdirp(webTargetDirectory);
  await copy(webSourceDirectory, webTargetDirectory, { overwrite: true });
}

main().catch((e) => {
  throw e;
});
