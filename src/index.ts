import { dirname } from "path"
import { fileURLToPath } from "url"
import { program } from '@commander-js/extra-typings';
import { Application } from "./Application.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

program
    .option('-c, --config <type>', 'add the specified type of cheese', 'config.yml');

program.parse();

const options = program.opts() as any

const config_file = options.config

const app = new Application(config_file)

app.start()