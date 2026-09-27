// All queries validated against the Shopify Admin GraphQL schema (2026-07).

export const CATALOG_QUERY = /* GraphQL */ `
  query Catalog($after: String) {
    products(first: 100, after: $after, query: "status:active") {
      nodes {
        id
        title
        handle
        productType
        vendor
        tags
        onlineStoreUrl
        priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
        compareAtPriceRange { maxVariantCompareAtPrice { amount } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const PRODUCT_QUERY = /* GraphQL */ `
  query Product($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      description
      productType
      onlineStoreUrl
      options { name values }
      variants(first: 100) {
        nodes {
          id
          title
          price
          compareAtPrice
          availableForSale
          inventoryPolicy
          selectedOptions { name value }
        }
      }
    }
  }
`;

const ORDER_FIELDS = /* GraphQL */ `
  id
  name
  createdAt
  cancelledAt
  closed
  displayFinancialStatus
  displayFulfillmentStatus
  phone
  email
  customer { id defaultPhoneNumber { phoneNumber } defaultEmailAddress { emailAddress } }
  shippingAddress { city phone }
  billingAddress { phone }
  lineItems(first: 20) { nodes { name quantity } }
  fulfillments(first: 10) {
    status
    displayStatus
    createdAt
    inTransitAt
    deliveredAt
    estimatedDeliveryAt
    trackingInfo(first: 3) { company number url }
  }
`;

export const ORDER_BY_NAME_QUERY = /* GraphQL */ `
  query OrderByName($q: String!) {
    orders(first: 3, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

export const CUSTOMER_BY_PHONE_QUERY = /* GraphQL */ `
  query CustomerByPhone($q: String!) {
    customers(first: 5, query: $q) {
      nodes {
        id
        firstName
        defaultPhoneNumber { phoneNumber }
        orders(first: 5, sortKey: CREATED_AT, reverse: true) {
          nodes { ${ORDER_FIELDS} }
        }
      }
    }
  }
`;

export const POLICIES_QUERY = /* GraphQL */ `
  query Policies {
    shop { shopPolicies { type title body url } }
  }
`;
