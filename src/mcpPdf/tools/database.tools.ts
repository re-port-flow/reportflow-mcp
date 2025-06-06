export const databaseTools = {
  query_workspace_data: {
    description: 'Query workspace information and related data',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        includeMembers: { type: 'boolean' },
        includePlans: { type: 'boolean' },
      },
    },
  },

  get_data_schema: {
    description: 'Get the schema/structure of requested data',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          enum: ['workspace', 'design', 'member', 'file', 'notification'],
        },
      },
    },
  },

  validate_upload_format: {
    description: 'Validate and describe required data format for uploads',
    inputSchema: {
      type: 'object',
      properties: {
        uploadType: { type: 'string' },
        sampleData: { type: 'object' },
      },
    },
  },
};
