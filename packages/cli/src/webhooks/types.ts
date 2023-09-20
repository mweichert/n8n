import type { Request } from 'express';
import type { IDataObject, IHttpRequestMethods } from 'n8n-workflow';

export type WebhookCORSRequest = Request & { method: 'OPTIONS' };

export type WebhookRequest = Request<{ path: string }> & { method: IHttpRequestMethods };

export type WaitingWebhookRequest = WebhookRequest & {
	params: WebhookRequest['path'] & { suffix?: string };
};

export interface WebhookResponseCallbackData {
	data?: IDataObject | IDataObject[];
	headers?: object;
	noWebhookResponse?: boolean;
	responseCode?: number;
}
