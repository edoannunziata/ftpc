export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends StorageError {}
export class ValidationError extends StorageError {}
export class RemoteNotFoundError extends StorageError {}
export class UnsupportedProtocolError extends StorageError {}
export class UnsupportedFeatureError extends StorageError {}
export class ListingError extends StorageError {}
export class TransferError extends StorageError {}
