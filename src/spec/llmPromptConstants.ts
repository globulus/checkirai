/**
 * Single source for LLM normalization prompts — update when `ObservableExpectationSchema` changes.
 */
export const OBSERVABLE_KINDS_PROMPT =
  '"text_present"|"role_present"|"url_matches"|"element_visible"|"element_enabled"|"time_present"|"toast_present"|"network_request"|"http_response"|"file_contains"' as const;

export const REQUIREMENT_TYPES_PROMPT =
  '"structure"|"navigation"|"form"|"persistence"|"visible_state"|"appearance"|"accessibility"|"integration"' as const;
