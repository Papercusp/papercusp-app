/**
 * Download the customer-run AWS setup template for the desktop path
 * (plan aws-byoc-gcp-parity-2026-10-01, P-013 / D-011).
 *
 * GET /workspace-hosts/aws-setup-template?accountId=<12 digits>&region=<region>[&principalArn=<arn>]
 *
 * Returns the CloudFormation JSON as an attachment. Its Outputs map onto the AWS connection form's
 * fields (AWS_CUSTOMER_SETUP_CONNECTION_FIELDS), which the response also names in a header so the
 * desktop surface can label them without hard-coding the mapping.
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  AWS_CUSTOMER_SETUP_CONNECTION_FIELDS,
  awsCustomerSetupTemplate,
} from '../../../workspace-host/aws-customer-setup-template';

export default defineTool({
  method: 'GET',
  path: '/workspace-hosts/aws-setup-template',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    let template;
    try {
      template = awsCustomerSetupTemplate({
        accountId: url.searchParams.get('accountId') ?? '',
        region: url.searchParams.get('region') ?? '',
        principalArn: url.searchParams.get('principalArn') ?? undefined,
      });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    return new Response(JSON.stringify(template.document, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition':
          `attachment; filename="papercusp-workspace-host-${template.accountId}-${template.region}.cloudformation.json"`,
        'x-papercusp-stack-name': template.stackName,
        'x-papercusp-connection-fields': JSON.stringify(AWS_CUSTOMER_SETUP_CONNECTION_FIELDS),
      },
    });
  },
});
