import type Bull from 'bull';
import { Service } from 'typedi';
import type { ExecutionError, IExecuteResponsePromiseData } from 'n8n-workflow';
import { EventEmitter } from 'events';

import config from '@/config';
import { Debounce } from '@/decorators/Debounce';
import { ActiveExecutions } from '@/ActiveExecutions';
import * as WebhookHelpers from '@/WebhookHelpers';
import {
	getRedisClusterClient,
	getRedisClusterNodes,
	getRedisPrefix,
	getRedisStandardClient,
} from '@/services/redis/RedisServiceHelper';
import type { RedisClientType } from '@/services/redis/RedisServiceBaseClasses';

export type JobId = Bull.JobId;
export type Job = Bull.Job<JobData>;
export type JobQueue = Bull.Queue<JobData>;

export interface JobData {
	executionId: string;
	loadStaticData: boolean;
}

export interface JobResponse {
	success: boolean;
	error?: ExecutionError;
}

export interface WebhookResponse {
	executionId: string;
	response: IExecuteResponsePromiseData;
}

@Service()
export class Queue extends EventEmitter {
	jobQueue: JobQueue;

	constructor(private activeExecutions: ActiveExecutions) {
		super();
	}

	async init() {
		const bullPrefix = config.getEnv('queue.bull.prefix');
		const prefix = getRedisPrefix(bullPrefix);
		const clusterNodes = getRedisClusterNodes();
		const usesRedisCluster = clusterNodes.length > 0;
		// eslint-disable-next-line @typescript-eslint/naming-convention
		const { default: Bull } = await import('bull');
		// eslint-disable-next-line @typescript-eslint/naming-convention
		const { default: Redis } = await import('ioredis');
		// Disabling ready check is necessary as it allows worker to
		// quickly reconnect to Redis if Redis crashes or is unreachable
		// for some time. With it enabled, worker might take minutes to realize
		// redis is back up and resume working.
		// More here: https://github.com/OptimalBits/bull/issues/890
		this.jobQueue = new Bull('jobs', {
			prefix,
			createClient: (type, clientConfig) =>
				usesRedisCluster
					? getRedisClusterClient(Redis, clientConfig, (type + '(bull)') as RedisClientType)
					: getRedisStandardClient(Redis, clientConfig, (type + '(bull)') as RedisClientType),
		});

		const instanceType = config.getEnv('generic.instanceType');
		if (instanceType === 'main') {
			const updateJobCounts = () => this.updateJobCounts();
			this.jobQueue.once('registered:global:progress', updateJobCounts);
			this.jobQueue.on('global:progress', updateJobCounts);
			this.jobQueue.on('global:failed', updateJobCounts);
			this.jobQueue.on('global:completed', updateJobCounts);
		}

		if (instanceType !== 'worker') {
			this.jobQueue.on('global:progress', (jobId, progress: WebhookResponse) => {
				this.activeExecutions.resolveResponsePromise(
					progress.executionId,
					WebhookHelpers.decodeWebhookResponse(progress.response),
				);
			});
		}
	}

	async add(jobData: JobData, jobOptions: object): Promise<Job> {
		const job = await this.jobQueue.add(jobData, jobOptions);
		this.updateJobCounts();
		return job;
	}

	async getJob(jobId: JobId): Promise<Job | null> {
		return this.jobQueue.getJob(jobId);
	}

	async getJobs(jobTypes: Bull.JobStatus[]): Promise<Job[]> {
		return this.jobQueue.getJobs(jobTypes);
	}

	async pause() {
		return this.jobQueue.pause(true);
	}

	process(concurrency: number) {
		void this.jobQueue.process(concurrency, (job: Job) => this.emit('on:job', job));
	}

	async stopJob(job: Job): Promise<boolean> {
		if (await job.isActive()) {
			// Job is already running so tell it to stop
			await job.progress(-1);
			return true;
		}
		// Job did not get started yet so remove from queue
		try {
			await job.remove();
			this.updateJobCounts();
			return true;
		} catch (e) {
			await job.progress(-1);
		}

		return false;
	}

	@Debounce(1000)
	private updateJobCounts() {
		void this.jobQueue.getJobCounts().then((jobCounts) => {
			this.emit('update:jobCount', jobCounts);
		});
	}
}

export declare interface Queue {
	on(event: 'update:jobCount', listener: (jobCounts: Bull.JobCounts) => void): this;
	on(event: 'on:job', listener: (job: Job) => void): this;
}
