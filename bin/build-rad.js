#!/usr/bin/env node

import { main } from "./cli/main.js";
import { help, parse } from "./cli/rad-options.js";
import { convert } from "./rad/convert.js";

await main(new URL(import.meta.url), "rad", convert, parse, help);
