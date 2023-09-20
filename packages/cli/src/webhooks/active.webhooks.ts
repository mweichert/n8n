import { Service } from 'typedi';
import type { Response } from 'express';
import type { INode, IWebhookData } from 'n8n-workflow';
import { NodeHelpers, Workflow, LoggerProxy as Logger } from 'n8n-workflow';

import { WorkflowRepository } from '@/databases/repositories';
import { NodeTypes } from '@/NodeTypes';
import { WebhookService } from '@/services/webhook.service';
import { NotFoundError } from '@/ResponseHelper';
import * as WorkflowExecuteAdditionalData from '@/WorkflowExecuteAdditionalData';
import { webhookNotFoundErrorMessage } from '@/utils';

import { AbstractWebhooks } from './abstract.webhooks';
import type { WebhookRequest, WebhookResponseCallbackData } from './types';

const WEBHOOK_PROD_UNREGISTERED_HINT =
	"The workflow must be active for a production URL to run successfully. You can activate the workflow using the toggle in the top-right of the editor. Note that unlike test URL calls, production URL calls aren't shown on the canvas (only in the executions list)";

@Service()
export class ActiveWebhooks extends AbstractWebhooks {
	constructor(
		nodeTypes: NodeTypes,
		private webhookService: WebhookService,
		private workflowRepository: WorkflowRepository,
	) {
		super(nodeTypes);
	}

	async getWebhookMethods(path: string) {
		return this.webhookService.getWebhookMethods(path);
	}

	async executeWebhook(
		request: WebhookRequest,
		response: Response,
	): Promise<WebhookResponseCallbackData> {
		const httpMethod = request.method;
		let path = request.params.path;

		Logger.debug(`Received webhook "${httpMethod}" for path "${path}"`);

		// Reset request parameters
		request.params = {} as WebhookRequest['params'];

		// Remove trailing slash
		if (path.endsWith('/')) {
			path = path.slice(0, -1);
		}

		const webhook = await this.webhookService.findWebhook(httpMethod, path);

		if (webhook === null) {
			throw new NotFoundError(
				webhookNotFoundErrorMessage(path, httpMethod),
				WEBHOOK_PROD_UNREGISTERED_HINT,
			);
		}

		// TODO: add a LRU cache here

		if (webhook.isDynamic) {
			const pathElements = path.split('/').slice(1);

			// extracting params from path
			// @ts-ignore
			webhook.webhookPath.split('/').forEach((ele, index) => {
				if (ele.startsWith(':')) {
					// write params to req.params
					// @ts-ignore
					request.params[ele.slice(1)] = pathElements[index];
				}
			});
		}

		const workflowData = await this.workflowRepository.findOne({
			where: { id: webhook.workflowId },
			relations: ['shared', 'shared.user', 'shared.user.globalRole'],
		});

		if (workflowData === null) {
			throw new NotFoundError(`Could not find workflow with id "${webhook.workflowId}"`);
		}

		const workflow = new Workflow({
			id: webhook.workflowId,
			name: workflowData.name,
			nodes: workflowData.nodes,
			connections: workflowData.connections,
			active: workflowData.active,
			nodeTypes: this.nodeTypes,
			staticData: workflowData.staticData,
			settings: workflowData.settings,
		});

		const additionalData = await WorkflowExecuteAdditionalData.getBase(
			workflowData.shared[0].userId,
		);

		const webhookData = NodeHelpers.getNodeWebhooks(
			workflow,
			workflow.getNode(webhook.node) as INode,
			additionalData,
		).find((w) => w.httpMethod === httpMethod && w.path === webhook.webhookPath) as IWebhookData;

		// Get the node which has the webhook defined to know where to start from and to
		// get additional data
		const startNode = workflow.getNode(webhookData.node);

		if (startNode === null) {
			throw new NotFoundError('Could not find node to process webhook.');
		}

		return new Promise((resolve, reject) => {
			const executionMode = 'webhook';
			void this.startWebhookExecution(
				workflow,
				webhookData,
				workflowData,
				startNode,
				executionMode,
				undefined,
				undefined,
				undefined,
				request,
				response,
				(error: Error | null, data: object) => {
					if (error !== null) reject(error);
					else resolve(data);
				},
			);
		});
	}
}
