import { Service } from 'typedi';
import type { Response } from 'express';
import { NodeHelpers, Workflow, LoggerProxy as Logger } from 'n8n-workflow';

import { NotFoundError, ConflictError } from '@/ResponseHelper';
import { NodeTypes } from '@/NodeTypes';
import type { IWorkflowDb } from '@/Interfaces';
import * as WorkflowExecuteAdditionalData from '@/WorkflowExecuteAdditionalData';
import { ExecutionRepository } from '@db/repositories';
import { OwnershipService } from '@/services/ownership.service';

import { AbstractWebhooks } from './abstract.webhooks';
import type { WaitingWebhookRequest, WebhookResponseCallbackData } from './types';

@Service()
export class WaitingWebhooks extends AbstractWebhooks {
	constructor(
		nodeTypes: NodeTypes,
		private executionRepository: ExecutionRepository,
		private ownershipService: OwnershipService,
	) {
		super(nodeTypes);
	}

	async getWebhookMethods() {
		// TODO: implement `getWebhookMethods` for CORS support
		// TODO: DO NOT MERGE THIS CODE
		return [];
	}

	async executeWebhook(
		req: WaitingWebhookRequest,
		res: Response,
	): Promise<WebhookResponseCallbackData> {
		const { path: executionId, suffix } = req.params;
		Logger.debug(`Received waiting-webhook "${req.method}" for execution "${executionId}"`);

		// Reset request parameters
		req.params = {} as WaitingWebhookRequest['params'];

		const execution = await this.executionRepository.findSingleExecution(executionId, {
			includeData: true,
			unflattenData: true,
		});

		if (!execution) {
			throw new NotFoundError(`The execution "${executionId} does not exist.`);
		}

		if (execution.finished || execution.data.resultData.error) {
			throw new ConflictError(`The execution "${executionId} has finished already.`);
		}

		const lastNodeExecuted = execution.data.resultData.lastNodeExecuted as string;

		// Set the node as disabled so that the data does not get executed again as it would result
		// in starting the wait all over again
		execution.data.executionData!.nodeExecutionStack[0].node.disabled = true;

		// Remove waitTill information else the execution would stop
		execution.data.waitTill = undefined;

		// Remove the data of the node execution again else it will display the node as executed twice
		execution.data.resultData.runData[lastNodeExecuted].pop();

		const { workflowData } = execution;

		const workflow = new Workflow({
			id: workflowData.id!,
			name: workflowData.name,
			nodes: workflowData.nodes,
			connections: workflowData.connections,
			active: workflowData.active,
			nodeTypes: this.nodeTypes,
			staticData: workflowData.staticData,
			settings: workflowData.settings,
		});

		let workflowOwner;
		try {
			workflowOwner = await this.ownershipService.getWorkflowOwnerCached(workflowData.id!);
		} catch (error) {
			throw new NotFoundError('Could not find workflow');
		}

		const startNode = workflow.getNode(lastNodeExecuted);
		if (startNode === null) {
			throw new NotFoundError('Could not find node to process webhook.');
		}

		const additionalData = await WorkflowExecuteAdditionalData.getBase();
		const webhookData = NodeHelpers.getNodeWebhooks(workflow, startNode, additionalData).find(
			(webhook) =>
				webhook.httpMethod === req.method &&
				webhook.path === (suffix ?? '') &&
				webhook.webhookDescription.restartWebhook === true,
		);

		if (webhookData === undefined) {
			// If no data got found it means that the execution can not be started via a webhook.
			// Return 404 because we do not want to give any data if the execution exists or not.
			const errorMessage = `The workflow for execution "${executionId}" does not contain a waiting webhook with a matching path/method.`;
			throw new NotFoundError(errorMessage);
		}

		const runExecutionData = execution.data;

		return new Promise((resolve, reject) => {
			const executionMode = 'webhook';
			void this.startWebhookExecution(
				workflow,
				webhookData,
				workflowData as IWorkflowDb,
				startNode,
				executionMode,
				undefined,
				runExecutionData,
				execution.id,
				req,
				res,
				(error: Error | null, data: object) => {
					if (error !== null) reject(error);
					else resolve(data);
				},
			);
		});
	}
}
