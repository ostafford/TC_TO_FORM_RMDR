/**
 * The bash the wizard tests run it with: /bin/bash where there is one, so on
 * a Mac they test macOS's own bash 3.2, the oldest the wizard has to work on,
 * even with a newer bash first on PATH (#114).
 */
import { existsSync } from "node:fs";

export const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
