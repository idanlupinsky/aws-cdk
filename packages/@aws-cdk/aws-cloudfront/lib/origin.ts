import { IBucket } from '@aws-cdk/aws-s3';
import { Construct, Duration, Token } from '@aws-cdk/core';
import { CfnDistribution } from './cloudfront.generated';
import { OriginProtocolPolicy } from './distribution';
import { OriginAccessIdentity } from './origin_access_identity';

/** The struct returned from {@link IOrigin.bind}. */
export interface OriginBindConfig {
  /**
   * The CloudFormation OriginProperty configuration for this Origin.
   *
   * @default - nothing is returned
   */
  readonly originProperty?: CfnDistribution.OriginProperty;
}

/**
 * Represents the concept of a CloudFront Origin.
 * You provide one or more origins when creating a Distribution.
 */
export interface IOrigin {
  /**
   * The method called when a given Origin is added
   * (for the first time) to a Distribution.
   */
  bind(scope: Construct, options: OriginBindOptions): OriginBindConfig;
}

/**
 * Properties to define an Origin.
 *
 * @experimental
 */
export interface OriginProps {
  /**
   * An optional path that CloudFront appends to the origin domain name when CloudFront requests content from the origin.
   * Must begin, but not end, with '/' (e.g., '/production/images').
   *
   * @default '/'
   */
  readonly originPath?: string;

  /**
   * The number of seconds that CloudFront waits when trying to establish a connection to the origin.
   * Valid values are 1-10 seconds, inclusive.
   *
   * @default Duration.seconds(10)
   */
  readonly connectionTimeout?: Duration;

  /**
   * The number of times that CloudFront attempts to connect to the origin; valid values are 1, 2, or 3 attempts.
   *
   * @default 3
   */
  readonly connectionAttempts?: number;

  /**
   * A list of HTTP header names and values that CloudFront adds to requests it sends to the origin.
   *
   * @default {}
   */
  readonly customHeaders?: Record<string, string>;
}

/**
 * Options passed to Origin.bind().
 *
 * @experimental
 */
export interface OriginBindOptions {
  /**
   * The identifier of this Origin,
   * as assigned by the Distribution this Origin has been used added to.
   */
  readonly originId: string;
}

/**
 * Represents a distribution origin, that describes the Amazon S3 bucket, HTTP server (for example, a web server),
 * Amazon MediaStore, or other server from which CloudFront gets your files.
 *
 * @experimental
 */
export abstract class Origin implements IOrigin {
  private readonly domainName: string;
  private readonly originPath?: string;
  private readonly connectionTimeout?: Duration;
  private readonly connectionAttempts?: number;
  private readonly customHeaders?: Record<string, string>;

  private originId?: string;

  protected constructor(domainName: string, props: OriginProps = {}) {
    validateIntInRangeOrUndefined('connectionTimeout', 1, 10, props.connectionTimeout?.toSeconds());
    validateIntInRangeOrUndefined('connectionAttempts', 1, 3, props.connectionAttempts, false);

    this.domainName = domainName;
    this.originPath = this.validateOriginPath(props.originPath);
    this.connectionTimeout = props.connectionTimeout;
    this.connectionAttempts = props.connectionAttempts;
    this.customHeaders = props.customHeaders;
  }

  /**
   * The unique id for this origin.
   *
   * Cannot be accesed until bind() is called.
   */
  public get id(): string {
    if (!this.originId) { throw new Error('Cannot access originId until `bind` is called.'); }
    return this.originId;
  }

  /**
   * Binds the origin to the associated Distribution. Can be used to grant permissions, create dependent resources, etc.
   */
  public bind(_scope: Construct, options: OriginBindOptions): OriginBindConfig {
    this.originId = options.originId;

    const s3OriginConfig = this.renderS3OriginConfig();
    const customOriginConfig = this.renderCustomOriginConfig();

    if (!s3OriginConfig && !customOriginConfig) {
      throw new Error('Subclass must override and provide either s3OriginConfig or customOriginConfig');
    }

    return { originProperty: {
      domainName: this.domainName,
      id: this.id,
      originPath: this.originPath,
      connectionAttempts: this.connectionAttempts,
      connectionTimeout: this.connectionTimeout?.toSeconds(),
      originCustomHeaders: this.renderCustomHeaders(),
      s3OriginConfig,
      customOriginConfig,
    }};
  }

  // Overridden by sub-classes to provide S3 origin config.
  protected renderS3OriginConfig(): CfnDistribution.S3OriginConfigProperty | undefined {
    return undefined;
  }

  // Overridden by sub-classes to provide custom origin config.
  protected renderCustomOriginConfig(): CfnDistribution.CustomOriginConfigProperty | undefined {
    return undefined;
  }

  private renderCustomHeaders(): CfnDistribution.OriginCustomHeaderProperty[] | undefined {
    if (!this.customHeaders || Object.entries(this.customHeaders).length === 0) { return undefined; }
    return Object.entries(this.customHeaders).map(([headerName, headerValue]) => {
      return { headerName, headerValue };
    });
  }

  /**
   * If the path is defined, it must start with a '/' and not end with a '/'.
   * This method takes in the originPath, and returns it back (if undefined) or adds/removes the '/' as appropriate.
   */
  private validateOriginPath(originPath?: string): string | undefined {
    if (Token.isUnresolved(originPath)) { return originPath; }
    if (originPath === undefined) { return undefined; }
    let path = originPath;
    if (!path.startsWith('/')) { path = '/' + path; }
    if (path.endsWith('/')) { path = path.substr(0, path.length - 1); }
    return path;
  }
}

/**
 * Properties for an Origin backed by an S3 bucket
 *
 * @experimental
 */
export interface S3OriginProps extends OriginProps {
  /**
   * The bucket to use as an origin.
   */
  readonly bucket: IBucket;
}

/**
 * An Origin specific to a S3 bucket (not configured for website hosting).
 *
 * Contains additional logic around bucket permissions and origin access identities.
 *
 * @experimental
 */
export class S3Origin extends Origin {
  private readonly bucket: IBucket;
  private originAccessIdentity!: OriginAccessIdentity;

  constructor(props: S3OriginProps) {
    super(props.bucket.bucketRegionalDomainName, props);
    this.bucket = props.bucket;
  }

  public bind(scope: Construct, options: OriginBindOptions): OriginBindConfig {
    if (!this.originAccessIdentity) {
      this.originAccessIdentity = new OriginAccessIdentity(scope, 'S3Origin');
      this.bucket.grantRead(this.originAccessIdentity);
    }
    return super.bind(scope, options);
  }

  protected renderS3OriginConfig(): CfnDistribution.S3OriginConfigProperty | undefined {
    return { originAccessIdentity: `origin-access-identity/cloudfront/${this.originAccessIdentity.originAccessIdentityName}` };
  }
}

/**
 * Properties for an Origin backed by an S3 website-configured bucket, load balancer, or custom HTTP server.
 *
 * @experimental
 */
export interface HttpOriginProps extends OriginProps {
  /**
   * Specifies the protocol (HTTP or HTTPS) that CloudFront uses to connect to the origin.
   *
   * @default OriginProtocolPolicy.HTTPS_ONLY
   */
  readonly protocolPolicy?: OriginProtocolPolicy;

  /**
   * The HTTP port that CloudFront uses to connect to the origin.
   *
   * @default 80
   */
  readonly httpPort?: number;

  /**
   * The HTTPS port that CloudFront uses to connect to the origin.
   *
   * @default 443
   */
  readonly httpsPort?: number;

  /**
   * Specifies how long, in seconds, CloudFront waits for a response from the origin, also known as the origin response timeout.
   * The valid range is from 1 to 60 seconds, inclusive.
   *
   * @default Duration.seconds(30)
   */
  readonly readTimeout?: Duration;

  /**
   * Specifies how long, in seconds, CloudFront persists its connection to the origin.
   * The valid range is from 1 to 60 seconds, inclusive.
   *
   * @default Duration.seconds(5)
   */
  readonly keepaliveTimeout?: Duration;
}

/**
 * An Origin for an HTTP server or S3 bucket configured for website hosting.
 *
 * @experimental
 */
export class HttpOrigin extends Origin {

  constructor(domainName: string, private readonly props: HttpOriginProps = {}) {
    super(domainName, props);

    validateIntInRangeOrUndefined('readTimeout', 1, 60, props.readTimeout?.toSeconds());
    validateIntInRangeOrUndefined('keepaliveTimeout', 1, 60, props.keepaliveTimeout?.toSeconds());
  }

  protected renderCustomOriginConfig(): CfnDistribution.CustomOriginConfigProperty | undefined {
    return {
      originProtocolPolicy: this.props.protocolPolicy ?? OriginProtocolPolicy.HTTPS_ONLY,
      httpPort: this.props.httpPort,
      httpsPort: this.props.httpsPort,
      originReadTimeout: this.props.readTimeout?.toSeconds(),
      originKeepaliveTimeout: this.props.keepaliveTimeout?.toSeconds(),
    };
  }
}

/**
 * Throws an error if a value is defined and not an integer or not in a range.
 */
function validateIntInRangeOrUndefined(name: string, min: number, max: number, value?: number, isDuration: boolean = true) {
  if (value === undefined) { return; }
  if (!Number.isInteger(value) || value < min || value > max) {
    const seconds = isDuration ? ' seconds' : '';
    throw new Error(`${name}: Must be an int between ${min} and ${max}${seconds} (inclusive); received ${value}.`);
  }
}