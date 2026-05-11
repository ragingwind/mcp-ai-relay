// Exercise every public subpath of `ai-relay` under
// `moduleResolution: "nodenext"`. Used by the publish-contract test.

import { verifyBearer } from "ai-relay";
import { verifyBearer as verifyBearerSub } from "ai-relay/auth";
import { loadConfig } from "ai-relay/env";
import type { OpenAIChatConfig, OpenAIChatResult, ToolDescriptor } from "ai-relay/openai";
import { makeOpenAIChatHandler, registerOpenAIChat } from "ai-relay/openai";

const _ok: boolean = verifyBearer("a", "a") && verifyBearerSub("b", "b");

const _cfg: OpenAIChatConfig = { apiKey: "k" };
const _handler = makeOpenAIChatHandler(_cfg);
const _register: typeof registerOpenAIChat = registerOpenAIChat;

const _loaded = loadConfig({ env: { AI_RELAY_API_KEY: "x" } });
const _providers = _loaded.providers.length;

const _result: OpenAIChatResult | undefined = undefined;
const _tool: ToolDescriptor | undefined = undefined;

export { _handler, _ok, _providers, _register, _result, _tool };
