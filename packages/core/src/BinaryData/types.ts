import type { Readable } from 'stream';
import type { BINARY_DATA_MODES } from './utils';

export namespace BinaryData {
	export type Mode = (typeof BINARY_DATA_MODES)[number];

	export type Config = {
		mode: 'default' | 'filesystem';
		availableModes: string[];
		localStoragePath: string;
	};

	export type Metadata = {
		fileName?: string;
		mimeType?: string;
		fileSize: number;
	};

	export type WriteResult = { fileId: string; fileSize: number };

	export type PreWriteMetadata = Omit<Metadata, 'fileSize'>;

	export type IdsForDeletion = Array<{ workflowId: string; executionId: string }>;

	export interface Manager {
		init(): Promise<void>;

		store(
			workflowId: string,
			executionId: string,
			bufferOrStream: Buffer | Readable,
			metadata: PreWriteMetadata,
		): Promise<WriteResult>;

		getPath(fileId: string): string;
		getAsBuffer(fileId: string): Promise<Buffer>;
		getAsStream(fileId: string, chunkSize?: number): Promise<Readable>;
		getMetadata(fileId: string): Promise<Metadata>;

		copyByFileId(workflowId: string, executionId: string, sourceFileId: string): Promise<string>;
		copyByFilePath(
			workflowId: string,
			executionId: string,
			filePath: string,
			metadata: PreWriteMetadata,
		): Promise<WriteResult>;

		deleteMany(ids: IdsForDeletion): Promise<void>;

		rename(oldFileId: string, newFileId: string): Promise<void>;
	}
}
