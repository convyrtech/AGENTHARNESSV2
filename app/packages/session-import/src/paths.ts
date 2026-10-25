/**
 * Where the other agents keep their chats (research/25 §2), Windows first. The home folder on
 * Windows is USERPROFILE, then HOMEDRIVE+HOMEPATH, then os.homedir(); each tool's own override
 * variable wins over its default (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_DATA_HOME / OPENCODE_DB, GEMINI_CLI_HOME). Pi CLI's override variables are not read: inside PRSLOY they
 * point at our own agent folder, and importing our own chats would duplicate them.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export function homeDir(env: Env = process.env, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") {
    if (env.USERPROFILE) return env.USERPROFILE;
    if (env.HOMEDRIVE && env.HOMEPATH) return `${env.HOMEDRIVE}${env.HOMEPATH}`;
    return homedir();
  }
  return env.HOME || homedir();
}

export type SourceRoots = {
  claudeProjects: string;
  codexHome: string;
  piSessions: string;
  /** OpenCode's data folder (`opencode.db`, `opencode-<channel>.db`). */
  opencodeData: string;
  /** `OPENCODE_DB`: one database file named by the user, read instead of the folder. */
  opencodeDb?: string;
  /** Gemini CLI's folder: `<GEMINI_CLI_HOME or home>/.gemini` (chats under `tmp/<project>/chats`). */
  geminiDir: string;
  /** Cursor's folder: `~/.cursor` (Agent / CLI transcripts under `projects/<encoded>/agent-transcripts`). */
  cursorDir: string;
  /** Where editors keep user data (`<root>/<Code|Cursor|…>/User/globalStorage`). */
  editorData: string;
  /** New Cline storage shared by its VS Code, CLI and JetBrains builds: `~/.cline/data`. */
  clineData: string;
  /** Kilo CLI's database (OpenCode's schema): `<XDG_DATA_HOME or ~/.local/share>/kilo/kilo.db`. */
  kiloDb?: string;
};

export function sourceRoots(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): SourceRoots {
  const home = homeDir(env, platform);
  return {
    claudeProjects: env.CLAUDE_CONFIG_DIR
      ? join(env.CLAUDE_CONFIG_DIR, "projects")
      : join(home, ".claude", "projects"),
    codexHome: env.CODEX_HOME || join(home, ".codex"),
    piSessions: join(home, ".pi", "agent", "sessions"),
    // OpenCode uses the XDG layout on Windows too: %USERPROFILE%\.local\share\opencode
    opencodeData: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode"),
    ...(env.OPENCODE_DB ? { opencodeDb: env.OPENCODE_DB } : {}),
    geminiDir: join(env.GEMINI_CLI_HOME || home, ".gemini"),
    cursorDir: join(home, ".cursor"),
    editorData:
      platform === "win32"
        ? env.APPDATA || join(home, "AppData", "Roaming")
        : platform === "darwin"
          ? join(home, "Library", "Application Support")
          : env.XDG_CONFIG_HOME || join(home, ".config"),
    clineData: join(home, ".cline", "data"),
    kiloDb: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "kilo", "kilo.db"),
  };
}
