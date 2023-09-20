import { Service } from 'typedi';
import type { Response } from 'express';
import type {
	IWebhookData,
	IHttpRequestMethods,
	WorkflowActivateMode,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import { Workflow } from 'n8n-workflow';
import * as NodeExecuteFunctions from 'n8n-core';

import type { IWorkflowDb } from '@/Interfaces';
import { Push } from '@/push';
import { NodeTypes } from '@/NodeTypes';
import { NotFoundError } from '@/ResponseHelper';
import { webhookNotFoundErrorMessage } from '@/utils';
import * as WorkflowExecuteAdditionalData from '@/WorkflowExecuteAdditionalData';

import { AbstractWebhooks } from './abstract.webhooks';
import type { WebhookRequest, WebhookResponseCallbackData } from './types';

const WEBHOOK_TEST_UNREGISTERED_HINT =
	"Click the 'Execute workflow' button on the canvas, then try again. (In test mode, the webhook only works for one call after you click this button)";

interface TestWebhookData {
	sessionId: string;
	timeout: NodeJS.Timeout;
	workflowData: IWorkflowDb;
	workflow: Workflow;
	destinationNode?: string;
}

@Service()
export class TestWebhooks extends AbstractWebhooks {
	private testWebhookData: Record<string, TestWebhookData> = {};

	private workflowWebhooks: Record<string, IWebhookData[]> = {};

	private webhookUrls: Record<string, IWebhookData[]> = {};

	constructor(
		nodeTypes: NodeTypes,
		private push: Push,
	) {
		super(nodeTypes);
	}

	/**
	 * Executes a test-webhook and returns the data. It also makes sure that the
	 * data gets additionally send to the UI. After the request got handled it
	 * automatically remove the test-webhook.
	 */
	async executeWebhook(
		request: WebhookRequest,
		response: Response,
	): Promise<WebhookResponseCallbackData> {
		const httpMethod = request.method;
		let path = request.params.path;

		// Reset request parameters
		request.params = {} as WebhookRequest['params'];

		// Remove trailing slash
		if (path.endsWith('/')) {
			path = path.slice(0, -1);
		}

		const { push, testWebhookData } = this;

		let webhookData: IWebhookData | undefined = this.get(httpMethod, path);

		// check if path is dynamic
		if (webhookData === undefined) {
			const pathElements = path.split('/');
			const webhookId = pathElements.shift();

			webhookData = this.get(httpMethod, pathElements.join('/'), webhookId);
			if (webhookData === undefined) {
				// The requested webhook is not registered
				const methods = await this.getWebhookMethods(path);
				throw new NotFoundError(
					webhookNotFoundErrorMessage(path, httpMethod, methods),
					WEBHOOK_TEST_UNREGISTERED_HINT,
				);
			}

			path = webhookData.path;
			// extracting params from path
			path.split('/').forEach((ele, index) => {
				if (ele.startsWith(':')) {
					// write params to req.params
					// @ts-ignore
					request.params[ele.slice(1)] = pathElements[index];
				}
			});
		}

		const { workflowId } = webhookData;
		const webhookKey = `${this.getWebhookKey(
			webhookData.httpMethod,
			webhookData.path,
			webhookData.webhookId,
		)}|${workflowId}`;

		// TODO: Clean that duplication up one day and improve code generally
		if (testWebhookData[webhookKey] === undefined) {
			// The requested webhook is not registered
			const methods = await this.getWebhookMethods(path);
			throw new NotFoundError(
				webhookNotFoundErrorMessage(path, httpMethod, methods),
				WEBHOOK_TEST_UNREGISTERED_HINT,
			);
		}

		const { destinationNode, sessionId, workflow, workflowData, timeout } =
			testWebhookData[webhookKey];

		// Get the node which has the webhook defined to know where to start from and to
		// get additional data
		const startNode = workflow.getNode(webhookData.node);
		if (startNode === null) {
			throw new NotFoundError('Could not find node to process webhook.');
		}

		return new Promise(async (resolve, reject) => {
			try {
				const executionMode = 'manual';
				const executionId = await this.startWebhookExecution(
					workflow,
					webhookData!,
					workflowData,
					startNode,
					executionMode,
					sessionId,
					undefined,
					undefined,
					request,
					response,
					(error: Error | null, data: WebhookResponseCallbackData) => {
						if (error !== null) reject(error);
						else resolve(data);
					},
					destinationNode,
				);

				// The workflow did not run as the request was probably setup related
				// or a ping so do not resolve the promise and wait for the real webhook
				// request instead.
				if (executionId === undefined) return;

				// Inform editor-ui that webhook got received
				push.send('testWebhookReceived', { workflowId, executionId }, sessionId);
			} catch {}

			// Delete webhook also if an error is thrown
			if (timeout) clearTimeout(timeout);
			delete testWebhookData[webhookKey];

			await this.removeWorkflow(workflow);
		});
	}

	/**
	 * Gets all request methods associated with a single test webhook
	 */
	async getWebhookMethods(path: string): Promise<IHttpRequestMethods[]> {
		const webhookMethods = Object.keys(this.webhookUrls)
			.filter((key) => key.includes(path))
			.map((key) => key.split('|')[0] as IHttpRequestMethods);
		if (!webhookMethods.length) {
			// The requested webhook is not registered
			throw new NotFoundError(webhookNotFoundErrorMessage(path), WEBHOOK_TEST_UNREGISTERED_HINT);
		}

		return webhookMethods;
	}

	/**
	 * Checks if it has to wait for webhook data to execute the workflow.
	 * If yes it waits for it and resolves with the result of the workflow if not it simply resolves with undefined
	 */
	async needsWebhookData(
		ownerId: string,
		workflowData: IWorkflowDb,
		mode: WorkflowExecuteMode,
		activation: WorkflowActivateMode,
		sessionId: string,
		destinationNode?: string,
	): Promise<boolean> {
		const additionalData = await WorkflowExecuteAdditionalData.getBase(ownerId);
		const workflow = new Workflow({
			id: workflowData.id?.toString(),
			name: workflowData.name,
			nodes: workflowData.nodes,
			connections: workflowData.connections,
			active: false,
			nodeTypes: this.nodeTypes,
			staticData: undefined,
			settings: workflowData.settings,
		});

		const webhooks = this.getWorkflowWebhooks(workflow, additionalData, destinationNode, true);
		if (!webhooks.find((webhook) => webhook.webhookDescription.restartWebhook !== true)) {
			// No webhooks found to start a workflow
			return false;
		}

		// Remove test-webhooks automatically if they do not get called (after 120 seconds)
		const timeout = setTimeout(() => {
			this.cancelTestWebhook(workflowData.id);
		}, 120000);

		const activatedKey: string[] = [];

		for (const webhookData of webhooks) {
			const key = `${this.getWebhookKey(
				webhookData.httpMethod,
				webhookData.path,
				webhookData.webhookId,
			)}|${workflowData.id}`;

			activatedKey.push(key);

			this.testWebhookData[key] = {
				sessionId,
				timeout,
				workflow,
				workflowData,
				destinationNode,
			};

			try {
				if (webhookData.path.endsWith('/')) {
					webhookData.path = webhookData.path.slice(0, -1);
				}

				const webhookKey = this.getWebhookKey(
					webhookData.httpMethod,
					webhookData.path,
					webhookData.webhookId,
				);

				// check that there is not a webhook already registered with that path/method
				if (this.webhookUrls[webhookKey] && !webhookData.webhookId) {
					throw new Error(
						`The URL path that the "${webhookData.node}" node uses is already taken. Please change it to something else.`,
					);
				}

				if (this.workflowWebhooks[webhookData.workflowId] === undefined) {
					this.workflowWebhooks[webhookData.workflowId] = [];
				}

				// Make the webhook available directly because sometimes to create it successfully
				// it gets called
				if (!this.webhookUrls[webhookKey]) {
					this.webhookUrls[webhookKey] = [];
				}
				this.webhookUrls[webhookKey].push(webhookData);

				try {
					await workflow.createWebhookIfNotExists(
						webhookData,
						NodeExecuteFunctions,
						mode,
						activation,
						true,
					);
				} catch (error) {
					// If there was a problem unregister the webhook again
					if (this.webhookUrls[webhookKey].length <= 1) {
						delete this.webhookUrls[webhookKey];
					} else {
						this.webhookUrls[webhookKey] = this.webhookUrls[webhookKey].filter(
							(webhook) => webhook.path !== webhookData.path,
						);
					}

					throw error;
				}

				this.workflowWebhooks[webhookData.workflowId].push(webhookData);
			} catch (error) {
				activatedKey.forEach((deleteKey) => delete this.testWebhookData[deleteKey]);

				await this.removeWorkflow(workflow);
				throw error;
			}
		}

		return true;
	}

	/** Removes a test webhook of the workflow with the given id */
	cancelTestWebhook(workflowId: string): boolean {
		let foundWebhook = false;
		const { push, testWebhookData } = this;

		for (const webhookKey of Object.keys(testWebhookData)) {
			const { sessionId, timeout, workflow, workflowData } = testWebhookData[webhookKey];

			if (workflowData.id !== workflowId) {
				continue;
			}

			clearTimeout(timeout);

			// Inform editor-ui that webhook got received
			push.send('testWebhookDeleted', { workflowId }, sessionId);

			// Remove the webhook
			delete testWebhookData[webhookKey];

			if (!foundWebhook) {
				// As it removes all webhooks of the workflow execute only once
				void this.removeWorkflow(workflow);
			}

			foundWebhook = true;
		}

		return foundWebhook;
	}

	/** Removes all the currently active test webhooks */
	async removeAll(): Promise<void> {
		const removePromises = Object.values(this.testWebhookData).map(async ({ workflow }) =>
			this.removeWorkflow(workflow),
		);
		await Promise.all(removePromises);
	}

	/** Returns webhookData if a webhook with matches is currently registered */
	private get(
		httpMethod: IHttpRequestMethods,
		path: string,
		webhookId?: string,
	): IWebhookData | undefined {
		const webhookKey = this.getWebhookKey(httpMethod, path, webhookId);
		if (this.webhookUrls[webhookKey] === undefined) {
			return undefined;
		}

		let webhook: IWebhookData | undefined;
		let maxMatches = 0;
		const pathElementsSet = new Set(path.split('/'));
		// check if static elements match in path
		// if more results have been returned choose the one with the most static-route matches
		this.webhookUrls[webhookKey].forEach((dynamicWebhook) => {
			const staticElements = dynamicWebhook.path.split('/').filter((ele) => !ele.startsWith(':'));
			const allStaticExist = staticElements.every((staticEle) => pathElementsSet.has(staticEle));

			if (allStaticExist && staticElements.length > maxMatches) {
				maxMatches = staticElements.length;
				webhook = dynamicWebhook;
			}
			// handle routes with no static elements
			else if (staticElements.length === 0 && !webhook) {
				webhook = dynamicWebhook;
			}
		});

		return webhook;
	}

	/** Returns key to uniquely identify a webhook */
	private getWebhookKey(httpMethod: IHttpRequestMethods, path: string, webhookId?: string): string {
		if (webhookId) {
			if (path.startsWith(webhookId)) {
				const cutFromIndex = path.indexOf('/') + 1;

				path = path.slice(cutFromIndex);
			}
			return `${httpMethod}|${webhookId}|${path.split('/').length}`;
		}
		return `${httpMethod}|${path}`;
	}

	/** Removes all webhooks of a workflow */
	private async removeWorkflow(workflow: Workflow): Promise<boolean> {
		const workflowId = workflow.id!.toString();

		if (this.workflowWebhooks[workflowId] === undefined) {
			// If it did not exist then there is nothing to remove
			return false;
		}

		const webhooks = this.workflowWebhooks[workflowId];

		const mode = 'internal';

		// Go through all the registered webhooks of the workflow and remove them

		for (const webhookData of webhooks) {
			await workflow.deleteWebhook(webhookData, NodeExecuteFunctions, mode, 'update', true);

			delete this.webhookUrls[
				this.getWebhookKey(webhookData.httpMethod, webhookData.path, webhookData.webhookId)
			];
		}

		// Remove also the workflow-webhook entry
		delete this.workflowWebhooks[workflowId];

		return true;
	}
}
