import { graphql } from '../../generated';

/**
 * The one write the Models screen makes.
 *
 * No `refetchQueries`: the catalogue is what the router serves, and a request
 * does not add to it. What the dialog needs back is the receipt — proof the row
 * exists, so the confirmation is something the server said rather than
 * something the browser assumed.
 */
export const REQUEST_MODEL = graphql(`
  mutation RequestModel($input: RequestModelInput!) {
    requestModel(input: $input) {
      id
      requestedModel
      notify
      createdAt
    }
  }
`);
