import { AuthTransformer } from '@aws-amplify/graphql-auth-transformer';
import { DefaultValueTransformer } from '@aws-amplify/graphql-default-value-transformer';
import { FunctionTransformer } from '@aws-amplify/graphql-function-transformer';
import { HttpTransformer } from '@aws-amplify/graphql-http-transformer';
import { IndexTransformer, PrimaryKeyTransformer } from '@aws-amplify/graphql-index-transformer';
import { MapsToTransformer } from '@aws-amplify/graphql-maps-to-transformer';
import { ModelTransformer } from '@aws-amplify/graphql-model-transformer';
import { PredictionsTransformer } from '@aws-amplify/graphql-predictions-transformer';
import {
  BelongsToTransformer,
  HasManyTransformer,
  HasOneTransformer,
  ManyToManyTransformer,
} from '@aws-amplify/graphql-relational-transformer';
import { SearchableModelTransformer } from '@aws-amplify/graphql-searchable-transformer';
import {
  collectDirectivesByTypeNames,
  DeploymentResources,
  getAppSyncServiceExtraDirectives,
  GraphQLTransform,
  ResolverConfig,
  TransformerProjectConfig,
} from '@aws-amplify/graphql-transformer-core';
import { Template } from '@aws-amplify/graphql-transformer-core/lib/config/project-config';
import { OverrideConfig } from '@aws-amplify/graphql-transformer-core/lib/transformation/types';
import { AppSyncAuthConfiguration, TransformerPluginProvider } from '@aws-amplify/graphql-transformer-interfaces';
import {
  $TSAny,
  $TSContext,
  $TSMeta,
  $TSObject,
  AmplifyCategories,
  AmplifySupportedService,
  getGraphQLTransformerAuthDocLink,
  JSONUtilities,
  pathManager,
  stateManager,
} from 'amplify-cli-core';
import { printer } from 'amplify-prompts';
import fs from 'fs-extra';
import { print } from 'graphql';
import { ResourceConstants } from 'graphql-transformer-common';
import { getSanityCheckRules, loadProject } from 'graphql-transformer-core';
import importFrom from 'import-from';
import importGlobal from 'import-global';
import _ from 'lodash';
import path from 'path';
import { destructiveUpdatesFlag, ProviderName } from '../constants';
/* eslint-disable-next-line import/no-cycle */
import { getTransformerVersion, searchablePushChecks } from '../transform-graphql-schema';
import { hashDirectory } from '../upload-appsync-files';
import { AmplifyCLIFeatureFlagAdapter } from '../utils/amplify-cli-feature-flag-adapter';
import { isAuthModeUpdated } from '../utils/auth-mode-compare';
import { schemaHasSandboxModeEnabled, showGlobalSandboxModeWarning, showSandboxModePrompts } from '../utils/sandbox-mode-helpers';
import { GraphQLSanityCheck, SanityCheckRules } from './sanity-check';
import { parseUserDefinedSlots } from './user-defined-slots';
import {
  getAdminRoles, getIdentityPoolId, mergeUserConfigWithTransformOutput, writeDeploymentToDisk,
} from './utils';

const PARAMETERS_FILENAME = 'parameters.json';
const SCHEMA_FILENAME = 'schema.graphql';
const SCHEMA_DIR_NAME = 'schema';
const ROOT_APPSYNC_S3_KEY = 'amplify-appsync-files';

const TRANSFORM_CONFIG_FILE_NAME = 'transform.conf.json';

const warnOnAuth = (map: $TSObject, docLink: string): void => {
  const unAuthModelTypes = Object.keys(map).filter(type => !map[type].includes('auth') && map[type].includes('model'));
  if (unAuthModelTypes.length) {
    printer.info(
      `
⚠️  WARNING: Some types do not have authorization rules configured. That means all create, read, update, and delete operations are denied on these types:`,
      'yellow',
    );
    printer.info(unAuthModelTypes.map(type => `\t - ${type}`).join('\n'), 'yellow');
    printer.info(`Learn more about "@auth" authorization rules here: ${docLink}`, 'yellow');
  }
};

const getTransformerFactory = (
  resourceDir: string,
): (options: TransformerFactoryArgs
) => Promise<TransformerPluginProvider[]> => async (options?: TransformerFactoryArgs) => {
  const modelTransformer = new ModelTransformer();
  const indexTransformer = new IndexTransformer();
  const hasOneTransformer = new HasOneTransformer();
  const authTransformer = new AuthTransformer({
    adminRoles: options.adminRoles ?? [],
    identityPoolId: options.identityPoolId,
  });
  const transformerList: TransformerPluginProvider[] = [
    modelTransformer,
    new FunctionTransformer(),
    new HttpTransformer(),
    new PredictionsTransformer(options?.storageConfig),
    new PrimaryKeyTransformer(),
    indexTransformer,
    new BelongsToTransformer(),
    new HasManyTransformer(),
    hasOneTransformer,
    new ManyToManyTransformer(modelTransformer, indexTransformer, hasOneTransformer, authTransformer),
    new DefaultValueTransformer(),
    authTransformer,
    new MapsToTransformer(),
    // TODO: initialize transformer plugins
  ];

  if (options?.addSearchableTransformer) {
    transformerList.push(new SearchableModelTransformer());
  }

  const customTransformersConfig = await loadProject(resourceDir);
  const customTransformerList = customTransformersConfig?.config?.transformers;
  const customTransformers = (Array.isArray(customTransformerList) ? customTransformerList : [])
    .map(transformer => {
      const fileUrlMatch = /^file:\/\/(.*)\s*$/m.exec(transformer);
      const modulePath = fileUrlMatch ? fileUrlMatch[1] : transformer;

      if (!modulePath) {
        throw new Error(`Invalid value specified for transformer: '${transformer}'`);
      }

      // The loading of transformer can happen multiple ways in the following order:
      // - modulePath is an absolute path to an NPM package
      // - modulePath is a package name, then it will be loaded from the project's root's node_modules with createRequireFromPath.
      // - modulePath is a name of a globally installed package
      let importedModule;
      const tempModulePath = modulePath.toString();

      try {
        if (path.isAbsolute(tempModulePath)) {
          // Load it by absolute path
          /* eslint-disable-next-line global-require, import/no-dynamic-require */
          importedModule = require(modulePath);
        } else {
          const projectRootPath = pathManager.findProjectRoot();
          const projectNodeModules = path.join(projectRootPath, 'node_modules');

          try {
            importedModule = importFrom(projectNodeModules, modulePath);
          } catch {
            // Intentionally left blank to try global
          }

          // Try global package install
          if (!importedModule) {
            importedModule = importGlobal(modulePath);
          }
        }

        // At this point we've to have an imported module, otherwise module loader, threw an error.
        return importedModule;
      } catch (error) {
        printer.error(`Unable to import custom transformer module(${modulePath}).`);
        printer.error(`You may fix this error by editing transformers at ${path.join(resourceDir, TRANSFORM_CONFIG_FILE_NAME)}`);
        throw error;
      }
    })
    .map(imported => {
      const CustomTransformer = imported.default;

      if (typeof CustomTransformer === 'function') {
        return new CustomTransformer();
      } if (typeof CustomTransformer === 'object') {
        // Todo: Use a shim to ensure that it adheres to TransformerProvider interface. For now throw error
        // return CustomTransformer;
        throw new Error("Custom Transformers' should implement TransformerProvider interface");
      }

      throw new Error("Custom Transformers' default export must be a function or an object");
    })
    .filter(customTransformer => customTransformer);

  if (customTransformers.length > 0) {
    transformerList.push(...customTransformers);
  }

  return transformerList;
};

/**
 * Transform GraphQL Schema
 */
export const transformGraphQLSchema = async (context: $TSContext, options): Promise<DeploymentResources|undefined> => {
  let resourceName: string;
  const backEndDir = pathManager.getBackendDirPath();
  const flags = context.parameters.options;
  if (flags['no-gql-override']) {
    return undefined;
  }

  let { resourceDir, parameters } = options;
  const { forceCompile } = options;

  // Compilation during the push step
  const { resourcesToBeCreated, resourcesToBeUpdated, allResources } = await context.amplify.getResourceStatus(AmplifyCategories.API);
  let resources = resourcesToBeCreated.concat(resourcesToBeUpdated);

  // When build folder is missing include the API
  // to be compiled without the backend/api/<api-name>/build
  // cloud formation push will fail even if there is no changes in the GraphQL API
  // https://github.com/aws-amplify/amplify-console/issues/10
  const resourceNeedCompile = allResources
    .filter(r => !resources.includes(r))
    .filter(r => {
      const buildDir = path.normalize(path.join(backEndDir, AmplifyCategories.API, r.resourceName, 'build'));
      return !fs.existsSync(buildDir);
    });
  resources = resources.concat(resourceNeedCompile);

  if (forceCompile) {
    resources = resources.concat(allResources);
  }
  resources = resources.filter(resource => resource.service === 'AppSync');

  if (!resourceDir) {
    // There can only be one appsync resource
    if (resources.length > 0) {
      const resource = resources[0];
      if (resource.providerPlugin !== ProviderName) {
        return undefined;
      }
      const { category } = resource;
      ({ resourceName } = resource);
      resourceDir = path.normalize(path.join(backEndDir, category, resourceName));
    } else {
      // No appsync resource to update/add
      return undefined;
    }
  }

  let previouslyDeployedBackendDir = options.cloudBackendDirectory;
  if (!previouslyDeployedBackendDir) {
    if (resources.length > 0) {
      const resource = resources[0];
      if (resource.providerPlugin !== ProviderName) {
        return undefined;
      }
      const { category } = resource;
      resourceName = resource.resourceName;
      const cloudBackendRootDir = pathManager.getCurrentCloudBackendDirPath();
      /* eslint-disable */
      previouslyDeployedBackendDir = path.normalize(path.join(cloudBackendRootDir, category, resourceName));
      /* eslint-enable */
    }
  }

  const parametersFilePath = path.join(resourceDir, PARAMETERS_FILENAME);

  if (!parameters && fs.existsSync(parametersFilePath)) {
    try {
      parameters = JSONUtilities.readJson(parametersFilePath);

      // OpenSearch Instance type support for x.y.search types
      if (parameters[ResourceConstants.PARAMETERS.OpenSearchInstanceType]) {
        parameters[ResourceConstants.PARAMETERS.OpenSearchInstanceType] = parameters[ResourceConstants.PARAMETERS.OpenSearchInstanceType]
          .replace('.search', '.elasticsearch');
      }
    } catch (e) {
      parameters = {};
    }
  }

  let { authConfig }: { authConfig: AppSyncAuthConfiguration } = options;

  if (_.isEmpty(authConfig) && !_.isEmpty(resources)) {
    authConfig = await context.amplify.invokePluginMethod(
      context,
      AmplifyCategories.API,
      AmplifySupportedService.APPSYNC,
      'getAuthConfig',
      [resources[0].resourceName],
    );
    // handle case where auth project is not migrated , if Auth not migrated above function will return empty Object
    if (_.isEmpty(authConfig)) {
      //
      // If we don't have an authConfig from the caller, use it from the
      // already read resources[0], which is an AppSync API.
      //
      if (resources[0].output.securityType) {
        // Convert to multi-auth format if needed.
        authConfig = {
          defaultAuthentication: {
            authenticationType: resources[0].output.securityType,
          },
          additionalAuthenticationProviders: [],
        };
      } else {
        ({ authConfig } = resources[0].output);
      }
    }
  }

  // for auth transformer we get any admin roles and a cognito identity pool to check for
  // potential authenticated roles outside of the provided authRole
  const adminRoles = await getAdminRoles(context, resourceName);
  const identityPoolId = await getIdentityPoolId(context);

  // for the predictions directive get storage config
  const s3Resource = s3ResourceAlreadyExists();
  const storageConfig = s3Resource ? getBucketName(s3Resource) : undefined;

  const buildDir = path.normalize(path.join(resourceDir, 'build'));
  const schemaFilePath = path.normalize(path.join(resourceDir, SCHEMA_FILENAME));
  const schemaDirPath = path.normalize(path.join(resourceDir, SCHEMA_DIR_NAME));
  let deploymentRootKey = await getPreviousDeploymentRootKey(previouslyDeployedBackendDir);
  if (!deploymentRootKey) {
    const deploymentSubKey = await hashDirectory(resourceDir);
    deploymentRootKey = `${ROOT_APPSYNC_S3_KEY}/${deploymentSubKey}`;
  }
  const projectBucket = options.dryRun ? 'fake-bucket' : getProjectBucket();
  const buildParameters = {
    ...parameters,
    S3DeploymentBucket: projectBucket,
    S3DeploymentRootKey: deploymentRootKey,
  };

  // If it is a dry run, don't create the build folder as it could make a follow-up command
  // to not to trigger a build, hence a corrupt deployment.
  if (!options.dryRun) {
    fs.ensureDirSync(buildDir);
  }

  const project = await loadProject(resourceDir);

  const lastDeployedProjectConfig = fs.existsSync(previouslyDeployedBackendDir)
    ? await loadProject(previouslyDeployedBackendDir)
    : undefined;
  const transformerVersion = await getTransformerVersion(context);
  const docLink = getGraphQLTransformerAuthDocLink(transformerVersion);
  const sandboxModeEnabled = schemaHasSandboxModeEnabled(project.schema, docLink);
  const directiveMap = collectDirectivesByTypeNames(project.schema);
  const hasApiKey = authConfig.defaultAuthentication.authenticationType === 'API_KEY'
    || authConfig.additionalAuthenticationProviders.some(a => a.authenticationType === 'API_KEY');
  const showSandboxModeMessage = sandboxModeEnabled && hasApiKey;

  if (showSandboxModeMessage) {
    showGlobalSandboxModeWarning(docLink);
  } else {
    warnOnAuth(directiveMap.types, docLink);
  }

  searchablePushChecks(context, directiveMap.types, parameters[ResourceConstants.PARAMETERS.AppSyncApiName]);

  const transformerListFactory = getTransformerFactory(resourceDir);

  if (sandboxModeEnabled && options.promptApiKeyCreation) {
    const apiKeyConfig = await showSandboxModePrompts(context);
    if (apiKeyConfig) authConfig.additionalAuthenticationProviders.push(apiKeyConfig);
  }

  let searchableTransformerFlag = false;

  if (directiveMap.directives.includes('searchable')) {
    searchableTransformerFlag = true;
  }

  // construct sanityCheckRules
  const ff = new AmplifyCLIFeatureFlagAdapter();
  const isNewAppSyncAPI: boolean = resourcesToBeCreated.some(resource => resource.service === 'AppSync');
  const allowDestructiveUpdates = context?.input?.options?.[destructiveUpdatesFlag] || context?.input?.options?.force;
  const sanityCheckRules = getSanityCheckRules(isNewAppSyncAPI, ff, allowDestructiveUpdates);
  let resolverConfig = {};
  if (!_.isEmpty(resources)) {
    resolverConfig = await context.amplify.invokePluginMethod(
      context,
      AmplifyCategories.API,
      AmplifySupportedService.APPSYNC,
      'getResolverConfig',
      [resources[0].resourceName],
    );
  }

  /**
   * if Auth is not migrated , we need to fetch resolver Config from transformer.conf.json
   * since above function will return empty object
   */
  if (_.isEmpty(resolverConfig)) {
    resolverConfig = project.config.ResolverConfig;
  }

  const buildConfig: ProjectOptions<TransformerFactoryArgs> = {
    ...options,
    buildParameters,
    projectDirectory: resourceDir,
    transformersFactory: transformerListFactory,
    transformersFactoryArgs: {
      addSearchableTransformer: searchableTransformerFlag,
      storageConfig,
      authConfig,
      adminRoles,
      identityPoolId,
    },
    rootStackFileName: 'cloudformation-template.json',
    currentCloudBackendDirectory: previouslyDeployedBackendDir,
    minify: options.minify,
    projectConfig: project,
    lastDeployedProjectConfig,
    authConfig,
    sandboxModeEnabled,
    sanityCheckRules,
    resolverConfig,
  };

  const transformerOutput = await buildAPIProject(buildConfig);

  printer.success(`GraphQL schema compiled successfully.\n\nEdit your schema at ${schemaFilePath} or \
place .graphql files in a directory at ${schemaDirPath}`);

  if (isAuthModeUpdated(options)) {
    parameters.AuthModeLastUpdated = new Date();
  }
  if (!options.dryRun) {
    JSONUtilities.writeJson(parametersFilePath, parameters);
  }

  return transformerOutput;
};

const getProjectBucket = (): string => {
  const meta: $TSMeta = stateManager.getMeta(undefined, { throwIfNotExist: false });
  const projectBucket = meta?.providers ? meta.providers[ProviderName].DeploymentBucketName : '';
  return projectBucket;
};

const getPreviousDeploymentRootKey = async (previouslyDeployedBackendDir: string): Promise<string|undefined> => {
  // this is the function
  let parameters;
  try {
    const parametersPath = path.join(previouslyDeployedBackendDir, `build/${PARAMETERS_FILENAME}`);
    const parametersExists = fs.existsSync(parametersPath);
    if (parametersExists) {
      const parametersString = await fs.readFile(parametersPath);
      parameters = JSON.parse(parametersString.toString());
    }
    return parameters.S3DeploymentRootKey;
  } catch (err) {
    return undefined;
  }
};

/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * Get the Directive definitions
 */
export const getDirectiveDefinitions = async (context: $TSContext, resourceDir: string): Promise<string> => {
  const transformList = await getTransformerFactory(resourceDir)({ addSearchableTransformer: true, authConfig: {} });
  const appSynDirectives = getAppSyncServiceExtraDirectives();
  const transformDirectives = transformList
    .map(transformPluginInst => [transformPluginInst.directive, ...transformPluginInst.typeDefinitions].map(node => print(node)).join('\n'))
    .join('\n');

  return [appSynDirectives, transformDirectives].join('\n');
};
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Check if storage exists in the project if not return undefined
 */
const s3ResourceAlreadyExists = (): string | undefined => {
  try {
    let resourceName: string;
    const amplifyMeta: $TSMeta = stateManager.getMeta(undefined, { throwIfNotExist: false });
    if (amplifyMeta?.[AmplifyCategories.STORAGE]) {
      const categoryResources = amplifyMeta[AmplifyCategories.STORAGE];
      Object.keys(categoryResources).forEach(resource => {
        if (categoryResources[resource].service === AmplifySupportedService.S3) {
          resourceName = resource;
        }
      });
    }
    return resourceName;
  } catch (error) {
    if (error.name === 'UndeterminedEnvironmentError') {
      return undefined;
    }
    throw error;
  }
};

const getBucketName = (s3ResourceName: string): { bucketName: string } => {
  const amplifyMeta = stateManager.getMeta();
  const stackName = amplifyMeta.providers.awscloudformation.StackName;
  const s3ResourcePath = pathManager.getResourceDirectoryPath(undefined, AmplifyCategories.STORAGE, s3ResourceName);
  const cliInputsPath = path.join(s3ResourcePath, 'cli-inputs.json');
  let bucketParameters: $TSObject;
  // get bucketParameters 1st from cli-inputs , if not present, then parameters.json
  if (fs.existsSync(cliInputsPath)) {
    bucketParameters = JSONUtilities.readJson(cliInputsPath);
  } else {
    bucketParameters = stateManager.getResourceParametersJson(undefined, AmplifyCategories.STORAGE, s3ResourceName);
  }
  const bucketName = stackName.startsWith('amplify-')
    ? `${bucketParameters.bucketName}\${hash}-\${env}`
    : `${bucketParameters.bucketName}${s3ResourceName}-\${env}`;
  return { bucketName };
};

type TransformerFactoryArgs = {
  addSearchableTransformer: boolean;
  authConfig: $TSAny;
  storageConfig?: $TSAny;
  adminRoles?: Array<string>;
  identityPoolId?: string;
};

/**
 * ProjectOptions Type Definition
 */
export type ProjectOptions<T> = {
  buildParameters: {
    S3DeploymentBucket: string;
    S3DeploymentRootKey: string;
  };
  projectDirectory: string;
  transformersFactory: (options: T) => Promise<TransformerPluginProvider[]>;
  transformersFactoryArgs: T;
  rootStackFileName: 'cloudformation-template.json';
  currentCloudBackendDirectory?: string;
  minify: boolean;
  lastDeployedProjectConfig?: TransformerProjectConfig;
  projectConfig: TransformerProjectConfig;
  resolverConfig?: ResolverConfig;
  dryRun?: boolean;
  authConfig?: AppSyncAuthConfiguration;
  stacks: Record<string, Template>;
  sandboxModeEnabled?: boolean;
  sanityCheckRules: SanityCheckRules;
  overrideConfig: OverrideConfig;
};

/**
 * buildAPIProject
 */
export const buildAPIProject = async (opts: ProjectOptions<TransformerFactoryArgs>): Promise<DeploymentResources|undefined> => {
  const schema = opts.projectConfig.schema.toString();
  // Skip building the project if the schema is blank
  if (!schema) {
    return undefined;
  }

  const builtProject = await _buildProject(opts);

  const buildLocation = path.join(opts.projectDirectory, 'build');
  const currentCloudLocation = opts.currentCloudBackendDirectory ? path.join(opts.currentCloudBackendDirectory, 'build') : undefined;

  if (opts.projectDirectory && !opts.dryRun) {
    await writeDeploymentToDisk(builtProject, buildLocation, opts.rootStackFileName, opts.buildParameters, opts.minify);
    const sanityChecker = new GraphQLSanityCheck(opts.sanityCheckRules, opts.rootStackFileName, currentCloudLocation, buildLocation);
    await sanityChecker.validate();
  }

  // TODO: update local env on api compile
  // await _updateCurrentMeta(opts);

  return builtProject;
};

const _buildProject = async (opts: ProjectOptions<TransformerFactoryArgs>): Promise<DeploymentResources> => {
  const userProjectConfig = opts.projectConfig;
  const stackMapping = userProjectConfig.config.StackMapping;
  const userDefinedSlots = {
    ...parseUserDefinedSlots(userProjectConfig.pipelineFunctions),
    ...parseUserDefinedSlots(userProjectConfig.resolvers),
  };

  // Create the transformer instances, we've to make sure we're not reusing them within the same CLI command
  // because the StackMapping feature already builds the project once.
  const transformers = await opts.transformersFactory(opts.transformersFactoryArgs);
  const transform = new GraphQLTransform({
    transformers,
    stackMapping,
    transformConfig: userProjectConfig.config,
    authConfig: opts.authConfig,
    buildParameters: opts.buildParameters,
    stacks: opts.projectConfig.stacks || {},
    featureFlags: new AmplifyCLIFeatureFlagAdapter(),
    sandboxModeEnabled: opts.sandboxModeEnabled,
    userDefinedSlots,
    resolverConfig: opts.resolverConfig,
    overrideConfig: opts.overrideConfig,
  });

  const schema = userProjectConfig.schema.toString();
  const transformOutput = transform.transform(schema);

  return mergeUserConfigWithTransformOutput(userProjectConfig, transformOutput, opts);
};
