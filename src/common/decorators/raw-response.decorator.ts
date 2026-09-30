import { SetMetadata } from "@nestjs/common";

export const RAW_RESPONSE = "rawResponse";

/** Opt an endpoint out of the response envelope (streams such as the chat SSE, file downloads). */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);
