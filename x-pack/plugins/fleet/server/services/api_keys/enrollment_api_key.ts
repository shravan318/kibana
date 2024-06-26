/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { v4 as uuidv4 } from 'uuid';
import Boom from '@hapi/boom';
import { i18n } from '@kbn/i18n';
import { errors } from '@elastic/elasticsearch';
import type { SavedObjectsClientContract, ElasticsearchClient } from '@kbn/core/server';

import { toElasticsearchQuery, fromKueryExpression } from '@kbn/es-query';

import type { ESSearchResponse as SearchResponse } from '@kbn/es-types';

import type { EnrollmentAPIKey, FleetServerEnrollmentAPIKey } from '../../types';
import { FleetError, EnrollmentKeyNameExistsError, EnrollmentKeyNotFoundError } from '../../errors';
import { ENROLLMENT_API_KEYS_INDEX } from '../../constants';
import { agentPolicyService } from '../agent_policy';
import { escapeSearchQueryPhrase } from '../saved_object';

import { auditLoggingService } from '../audit_logging';

import { appContextService } from '../app_context';

import { invalidateAPIKeys } from './security';

const uuidRegex =
  /^\([0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}\)$/;

export async function listEnrollmentApiKeys(
  esClient: ElasticsearchClient,
  options: {
    page?: number;
    perPage?: number;
    kuery?: string;
    query?: ReturnType<typeof toElasticsearchQuery>;
    showInactive?: boolean;
  }
): Promise<{ items: EnrollmentAPIKey[]; total: any; page: any; perPage: any }> {
  const { page = 1, perPage = 20, kuery } = options;
  const query = options.query ?? (kuery && toElasticsearchQuery(fromKueryExpression(kuery)));

  const res = await esClient.search<SearchResponse<FleetServerEnrollmentAPIKey, {}>>({
    index: ENROLLMENT_API_KEYS_INDEX,
    from: (page - 1) * perPage,
    size: perPage,
    track_total_hits: true,
    rest_total_hits_as_int: true,
    ignore_unavailable: true,
    body: {
      sort: [{ created_at: { order: 'desc' } }],
      ...(query ? { query } : {}),
    },
  });

  // @ts-expect-error @elastic/elasticsearch _source is optional
  const items = res.hits.hits.map(esDocToEnrollmentApiKey);

  return {
    items,
    total: res.hits.total as number,
    page,
    perPage,
  };
}

export async function hasEnrollementAPIKeysForPolicy(
  esClient: ElasticsearchClient,
  policyId: string
) {
  const res = await listEnrollmentApiKeys(esClient, {
    kuery: `policy_id:"${policyId}"`,
  });

  return res.total !== 0;
}

export async function getEnrollmentAPIKey(
  esClient: ElasticsearchClient,
  id: string
): Promise<EnrollmentAPIKey> {
  try {
    const body = await esClient.get<FleetServerEnrollmentAPIKey>({
      index: ENROLLMENT_API_KEYS_INDEX,
      id,
    });

    // @ts-expect-error esDocToEnrollmentApiKey doesn't accept optional _source
    return esDocToEnrollmentApiKey(body);
  } catch (e) {
    if (e instanceof errors.ResponseError && e.statusCode === 404) {
      throw new EnrollmentKeyNotFoundError(`Enrollment api key ${id} not found`);
    }

    throw e;
  }
}

/**
 * Invalidate an api key and mark it as inactive
 * @param id
 */
export async function deleteEnrollmentApiKey(
  esClient: ElasticsearchClient,
  id: string,
  forceDelete = false
) {
  const logger = appContextService.getLogger();
  logger.debug(`Deleting enrollment API key ${id}`);

  const enrollmentApiKey = await getEnrollmentAPIKey(esClient, id);

  auditLoggingService.writeCustomAuditLog({
    message: `User deleting enrollment API key [id=${enrollmentApiKey.id}] [api_key_id=${enrollmentApiKey.api_key_id}]`,
  });

  await invalidateAPIKeys([enrollmentApiKey.api_key_id]);

  if (forceDelete) {
    await esClient.delete({
      index: ENROLLMENT_API_KEYS_INDEX,
      id,
      refresh: 'wait_for',
    });
  } else {
    await esClient.update({
      index: ENROLLMENT_API_KEYS_INDEX,
      id,
      body: {
        doc: {
          active: false,
        },
      },
      refresh: 'wait_for',
    });
  }
  logger.debug(
    `Deleted enrollment API key ${enrollmentApiKey.id} [api_key_id=${enrollmentApiKey.api_key_id}`
  );
}

export async function deleteEnrollmentApiKeyForAgentPolicyId(
  esClient: ElasticsearchClient,
  agentPolicyId: string
) {
  let hasMore = true;
  let page = 1;
  while (hasMore) {
    const { items } = await listEnrollmentApiKeys(esClient, {
      page: page++,
      perPage: 100,
      kuery: `policy_id:${agentPolicyId}`,
    });

    if (items.length === 0) {
      hasMore = false;
    }

    for (const apiKey of items) {
      await deleteEnrollmentApiKey(esClient, apiKey.id);
    }
  }
}

export async function generateEnrollmentAPIKey(
  soClient: SavedObjectsClientContract,
  esClient: ElasticsearchClient,
  data: {
    name?: string;
    expiration?: string;
    agentPolicyId: string;
    forceRecreate?: boolean;
  }
): Promise<EnrollmentAPIKey> {
  const id = uuidv4();
  const { name: providedKeyName, forceRecreate } = data;
  const logger = appContextService.getLogger();
  logger.debug(`Creating enrollment API key ${data}`);

  if (data.agentPolicyId) {
    await validateAgentPolicyId(soClient, data.agentPolicyId);
  }
  const agentPolicyId = data.agentPolicyId;

  if (providedKeyName && !forceRecreate) {
    let hasMore = true;
    let page = 1;
    let keys: EnrollmentAPIKey[] = [];
    while (hasMore) {
      const { items } = await listEnrollmentApiKeys(esClient, {
        page: page++,
        perPage: 100,
        query: getQueryForExistingKeyNameOnPolicy(agentPolicyId, providedKeyName),
      });
      if (items.length === 0) {
        hasMore = false;
      } else {
        keys = keys.concat(items);
      }
    }

    if (
      keys.length > 0 &&
      keys.some((k: EnrollmentAPIKey) =>
        // Prevent false positives when the providedKeyName is a prefix of a token name that already exists
        // After removing the providedKeyName and trimming whitespace, the only string left should be a uuid in parens.
        k.name?.replace(providedKeyName, '').trim().match(uuidRegex)
      )
    ) {
      throw new EnrollmentKeyNameExistsError(
        i18n.translate('xpack.fleet.serverError.enrollmentKeyDuplicate', {
          defaultMessage:
            'An enrollment key named {providedKeyName} already exists for agent policy {agentPolicyId}',
          values: {
            providedKeyName,
            agentPolicyId,
          },
        })
      );
    }
  }

  const name = providedKeyName ? `${providedKeyName} (${id})` : id;

  auditLoggingService.writeCustomAuditLog({
    message: `User creating enrollment API key [name=${name}] [policy_id=${agentPolicyId}]`,
  });
  logger.debug(`Creating enrollment API key [name=${name}] [policy_id=${agentPolicyId}]`);

  const key = await esClient.security
    .createApiKey({
      body: {
        name,
        metadata: {
          managed_by: 'fleet',
          managed: true,
          type: 'enroll',
          policy_id: data.agentPolicyId,
        },
        role_descriptors: {
          // Useless role to avoid to have the privilege of the user that created the key
          'fleet-apikey-enroll': {
            cluster: [],
            index: [],
            applications: [
              {
                application: 'fleet',
                privileges: ['no-privileges'],
                resources: ['*'],
              },
            ],
          },
        },
      },
    })
    .catch((err) => {
      throw new FleetError(`Impossible to create an api key: ${err.message}`);
    });

  if (!key) {
    throw new FleetError(
      i18n.translate('xpack.fleet.serverError.unableToCreateEnrollmentKey', {
        defaultMessage: 'Unable to create an enrollment api key',
      })
    );
  }

  const apiKey = Buffer.from(`${key.id}:${key.api_key}`).toString('base64');

  const body = {
    active: true,
    api_key_id: key.id,
    api_key: apiKey,
    name,
    policy_id: agentPolicyId,
    created_at: new Date().toISOString(),
  };

  const res = await esClient.create({
    index: ENROLLMENT_API_KEYS_INDEX,
    body,
    id,
    refresh: 'wait_for',
  });

  return {
    id: res._id,
    ...body,
  };
}

export async function ensureDefaultEnrollmentAPIKeyForAgentPolicy(
  soClient: SavedObjectsClientContract,
  esClient: ElasticsearchClient,
  agentPolicyId: string
) {
  const hasKey = await hasEnrollementAPIKeysForPolicy(esClient, agentPolicyId);

  if (hasKey) {
    return;
  }

  return generateEnrollmentAPIKey(soClient, esClient, {
    name: `Default`,
    agentPolicyId,
    forceRecreate: true, // Always generate a new enrollment key when Fleet is being set up
  });
}

function getQueryForExistingKeyNameOnPolicy(agentPolicyId: string, providedKeyName: string) {
  const query = {
    bool: {
      filter: [
        {
          bool: {
            should: [{ match_phrase: { policy_id: agentPolicyId } }],
            minimum_should_match: 1,
          },
        },
        {
          bool: {
            should: [{ query_string: { fields: ['name'], query: `(${providedKeyName}) *` } }],
            minimum_should_match: 1,
          },
        },
      ],
    },
  };

  return query;
}

export async function getEnrollmentAPIKeyById(esClient: ElasticsearchClient, apiKeyId: string) {
  const res = await esClient.search<FleetServerEnrollmentAPIKey>({
    index: ENROLLMENT_API_KEYS_INDEX,
    ignore_unavailable: true,
    q: `api_key_id:${escapeSearchQueryPhrase(apiKeyId)}`,
  });

  // @ts-expect-error esDocToEnrollmentApiKey doesn't accept optional _source
  const [enrollmentAPIKey] = res.hits.hits.map(esDocToEnrollmentApiKey);

  if (enrollmentAPIKey?.api_key_id !== apiKeyId) {
    throw new FleetError(
      i18n.translate('xpack.fleet.serverError.returnedIncorrectKey', {
        defaultMessage: 'Find enrollmentKeyById returned an incorrect key',
      })
    );
  }

  return enrollmentAPIKey;
}

async function validateAgentPolicyId(soClient: SavedObjectsClientContract, agentPolicyId: string) {
  try {
    await agentPolicyService.get(soClient, agentPolicyId);
  } catch (e) {
    if (e.isBoom && e.output.statusCode === 404) {
      throw Boom.badRequest(
        i18n.translate('xpack.fleet.serverError.agentPolicyDoesNotExist', {
          defaultMessage: 'Agent policy {agentPolicyId} does not exist',
          values: { agentPolicyId },
        })
      );
    }
    throw e;
  }
}

function esDocToEnrollmentApiKey(doc: {
  _id: string;
  _source: FleetServerEnrollmentAPIKey;
}): EnrollmentAPIKey {
  return {
    id: doc._id,
    ...doc._source,
    created_at: doc._source.created_at as string,
    active: doc._source.active || false,
  };
}
