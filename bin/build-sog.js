#!/usr/bin/env node

import { main } from "./cli/main.js";
import { help, parse } from "./cli/sog-options.js";
import { convert } from "./sog/convert.js";

await main(new URL(import.meta.url), "sog", convert, parse, help);
