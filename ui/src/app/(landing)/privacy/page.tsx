import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy - Lumen",
  description: "Privacy Policy for Lumen billing platform by Pretzel AI GmbH",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-16">
      <div className="prose prose-gray max-w-none">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">
          Privacy Policy
        </h1>

        <p className="text-gray-600 mb-8">
          <strong>Effective Date:</strong> May 1, 2025
          <br />
          <strong>Last Updated:</strong> July 30, 2025
        </p>

        <div className="space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              1. Introduction
            </h2>
            <p className="text-gray-700 leading-relaxed">
              Pretzel AI GmbH, operating the Lumen billing platform
              (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) respects your
              privacy and is committed to protecting your personal data. This
              privacy policy explains how we collect, use, store, and protect
              your information when you use our billing and payment platform
              services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              2. Information We Collect
            </h2>

            <h3 className="text-xl font-medium text-gray-900 mb-3">
              2.1 Merchant Account Information
            </h3>
            <p className="text-gray-700 leading-relaxed mb-4">
              When you create a merchant account, we collect:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>Name and email address</li>
              <li>Account credentials (encrypted)</li>
              <li>Business information and tax identification</li>
              <li>Billing addresses</li>
              <li>Payment provider API keys (encrypted)</li>
            </ul>

            <h3 className="text-xl font-medium text-gray-900 mb-3">
              2.2 Customer Data (Processed on Your Behalf)
            </h3>
            <p className="text-gray-700 leading-relaxed mb-4">
              As a billing platform, we process your customers&apos; data on
              your behalf:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>Customer names, emails, and contact information</li>
              <li>Billing and shipping addresses</li>
              <li>Subscription and usage data</li>
              <li>Invoice and payment history</li>
            </ul>

            <h3 className="text-xl font-medium text-gray-900 mb-3">
              2.3 Payment Processing
            </h3>
            <p className="text-gray-700 leading-relaxed mb-4">
              <strong>Important:</strong> We do not collect or store payment
              card information directly. Payment data is handled securely by our
              payment processors (Stripe) using their payment elements.
            </p>
            <p className="text-gray-700 leading-relaxed mb-4">
              We do collect and store:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>Transaction metadata and status</li>
              <li>Invoice records and payment history</li>
              <li>Tax exemption certificates (if applicable)</li>
              <li>Payment method preferences (not card details)</li>
            </ul>

            <h3 className="text-xl font-medium text-gray-900 mb-3">
              2.4 Usage and Analytics Data
            </h3>
            <p className="text-gray-700 leading-relaxed mb-4">
              To improve our platform, we use PostHog to collect:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>Page views, clicks, and user interactions</li>
              <li>Session recordings and heatmaps</li>
              <li>Performance metrics and error tracking</li>
              <li>Feature usage patterns</li>
            </ul>

            <h3 className="text-xl font-medium text-gray-900 mb-3">
              2.5 System Logs
            </h3>
            <p className="text-gray-700 leading-relaxed mb-4">
              We maintain system logs for security and debugging purposes,
              including:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>API requests and responses (excluding sensitive data)</li>
              <li>System errors and performance metrics</li>
              <li>Access logs and security events</li>
            </ul>
            <p className="text-sm text-gray-600">
              <strong>Retention:</strong> System logs are automatically deleted
              after 90 days.
            </p>

            <h3 className="text-xl font-medium text-gray-900 mb-3">
              2.6 Communications
            </h3>
            <p className="text-gray-700 leading-relaxed">
              We may collect information from your communications with us,
              including support tickets, emails, and feedback submissions.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              3. How We Use Your Information
            </h2>

            <h3 className="text-xl font-medium text-gray-900 mb-3">
              3.1 Service Provision
            </h3>
            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>Process payments and manage subscriptions</li>
              <li>Generate invoices and handle billing</li>
              <li>Manage your account and authenticate access</li>
              <li>Provide customer support</li>
              <li>Send service-related communications</li>
            </ul>

            <h3 className="text-xl font-medium text-gray-900 mb-3">
              3.2 Platform Improvement
            </h3>
            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>Analyze usage patterns to enhance user experience</li>
              <li>Identify and fix technical issues</li>
              <li>Develop new features and services</li>
              <li>Optimize platform performance</li>
            </ul>

            <h3 className="text-xl font-medium text-gray-900 mb-3">
              3.3 Legal and Security
            </h3>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>Comply with legal obligations and regulations</li>
              <li>Prevent fraud and ensure platform security</li>
              <li>Protect our rights and interests</li>
              <li>Respond to legal requests and court orders</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              4. Legal Basis for Processing
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              Under GDPR, we process your personal data based on:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>
                <strong>Contract Performance:</strong> To provide our billing
                and payment services
              </li>
              <li>
                <strong>Legitimate Interest:</strong> For analytics, platform
                improvement, and security
              </li>
              <li>
                <strong>Legal Obligation:</strong> For tax reporting, fraud
                prevention, and regulatory compliance
              </li>
              <li>
                <strong>Consent:</strong> For certain analytics features with
                persistent storage
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              5. Service Providers and Infrastructure
            </h2>

            <p className="text-gray-700 leading-relaxed mb-4">
              <strong>
                We do not sell, rent, or share your personal data with third
                parties.
              </strong>
              We use trusted service providers to help us operate our platform.
              These providers process data on our behalf under strict
              contractual obligations:
            </p>

            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>
                <strong>AWS (Amazon Web Services):</strong> Secure cloud hosting
                for our platform and databases
              </li>
              <li>
                <strong>Stripe:</strong> Payment processing (they handle card
                data directly, not us)
              </li>
              <li>
                <strong>Dodo Payments:</strong> Alternative payment processing
                service
              </li>
              <li>
                <strong>PostHog:</strong> Privacy-focused analytics platform
              </li>
              <li>
                <strong>Trigger.dev:</strong> Background job processing
              </li>
            </ul>

            <p className="text-gray-700 leading-relaxed">
              These providers are data processors acting on our instructions
              only. They cannot use your data for their own purposes and must
              meet strict security and privacy standards.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              6. Data Security
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              We implement industry-standard security measures to protect your
              data:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>
                <strong>No payment card storage:</strong> We never store credit
                card information - payment data is handled directly by Stripe
                using secure payment elements
              </li>
              <li>
                <strong>Encrypted sensitive data:</strong> Payment provider API
                keys and credentials are encrypted at rest using
                industry-standard encryption
              </li>
              <li>Secure authentication protocols and session management</li>
              <li>Regular security monitoring and access controls</li>
              <li>Secure cloud infrastructure hosted on AWS</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              7. Data Retention
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              We retain your data for as long as necessary to provide our
              services and comply with legal obligations:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>
                <strong>Account Data:</strong> While your account is active and
                for 7 years after closure for legal compliance
              </li>
              <li>
                <strong>Transaction Records:</strong> For 7 years to comply with
                financial regulations (no card data stored)
              </li>
              <li>
                <strong>Analytics Data:</strong> For 2 years to improve our
                platform
              </li>
              <li>
                <strong>System Logs:</strong> Automatically deleted after 90
                days
              </li>
              <li>
                <strong>Communications:</strong> For 3 years for support and
                legal purposes
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              8. Your Rights
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              Under GDPR and other privacy laws, you have the right to:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>
                <strong>Access:</strong> Request a copy of your personal data
              </li>
              <li>
                <strong>Rectification:</strong> Correct inaccurate or incomplete
                data
              </li>
              <li>
                <strong>Erasure:</strong> Request deletion of your personal data
              </li>
              <li>
                <strong>Portability:</strong> Receive your data in a
                machine-readable format
              </li>
              <li>
                <strong>Restriction:</strong> Limit how we process your data
              </li>
              <li>
                <strong>Objection:</strong> Object to processing based on
                legitimate interests
              </li>
              <li>
                <strong>Withdraw Consent:</strong> For processing based on
                consent
              </li>
            </ul>

            <p className="text-gray-700 leading-relaxed">
              To exercise any of these rights, please contact us at{" "}
              <a
                href="mailto:help@getlumen.dev"
                className="text-blue-600 hover:text-blue-800 underline"
              >
                help@getlumen.dev
              </a>
              . We will respond within 30 days of your request.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              9. Cookies and Tracking
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              We use cookies and similar technologies to:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2 mb-6">
              <li>Maintain your login session (essential cookies)</li>
              <li>Remember your preferences and settings</li>
              <li>Analyze platform usage and performance</li>
              <li>
                Improve user experience through session recordings and heatmaps
              </li>
            </ul>

            <p className="text-gray-700 leading-relaxed">
              You can control cookie preferences through our cookie banner or in
              your browser settings. Disabling essential cookies may affect
              platform functionality.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              10. International Transfers
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              Your data may be transferred to and processed in countries outside
              the European Union, including the United States where our cloud
              infrastructure (AWS) is located.
            </p>
            <p className="text-gray-700 leading-relaxed mb-4">
              We ensure appropriate safeguards are in place for all
              international transfers:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>
                <strong>Standard Contractual Clauses (SCCs):</strong> We use
                EU-approved contractual clauses with all service providers
              </li>
              <li>
                <strong>Adequacy Decisions:</strong> Where available, we rely on
                EU Commission adequacy decisions
              </li>
              <li>
                <strong>Data Processing Agreements:</strong> All third-party
                processors sign comprehensive data protection agreements
              </li>
              <li>
                <strong>Technical Safeguards:</strong> Data is encrypted in
                transit and at rest regardless of location
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              11. Children&apos;s Privacy
            </h2>
            <p className="text-gray-700 leading-relaxed">
              Our services are not intended for children under 16. We do not
              knowingly collect personal information from children under 16. If
              we become aware that we have collected personal information from a
              child under 16, we will take steps to delete such information.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              12. Automated Decision Making
            </h2>
            <p className="text-gray-700 leading-relaxed">
              We do not use automated decision making or profiling that produces
              legal effects or significantly affects you. Any automated
              processing we perform (such as fraud detection or usage analytics)
              is for operational purposes only and does not result in automated
              decisions about your access to services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              13. Changes to This Policy
            </h2>
            <p className="text-gray-700 leading-relaxed">
              We may update this privacy policy from time to time. We will
              notify you of any material changes by posting the new policy on
              our website and updating the &quot;Last Updated&quot; date. Your
              continued use of our services after such changes constitutes
              acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              14. Company Information & Contact
            </h2>

            <div className="bg-gray-50 p-6 rounded-lg mb-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Legal Entity Details
              </h3>
              <div className="grid md:grid-cols-2 gap-4 text-gray-700">
                <div>
                  <p>
                    <strong>Company:</strong> Pretzel AI GmbH
                  </p>
                  <p>
                    <strong>Product:</strong> Lumen Billing Platform
                  </p>
                  <p>
                    <strong>Address:</strong>
                    <br />
                    c/o Prasoon Shukla
                    <br />
                    Jungstraße 12
                    <br />
                    10247 Berlin, Germany
                  </p>
                </div>
                <div>
                  <p>
                    <strong>Commercial Register:</strong> HRB 260412 B
                  </p>
                  <p>
                    <strong>Registration Court:</strong> Amtsgericht
                    Charlottenburg
                  </p>
                  <p>
                    <strong>VAT ID:</strong> DE366513651
                  </p>
                  <p>
                    <strong>Managing Directors:</strong>
                    <br />
                    Prasoon Shukla
                    <br />
                    Ramon Garate Funcia
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 p-6 rounded-lg">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Privacy & Data Protection
              </h3>
              <p className="text-gray-700 leading-relaxed mb-4">
                If you have questions about this privacy policy or our data
                practices, please contact us:
              </p>
              <div className="space-y-3 text-gray-700">
                <p>
                  <strong>Email:</strong>{" "}
                  <a
                    href="mailto:help@getlumen.dev"
                    className="text-blue-600 hover:text-blue-800 underline"
                  >
                    help@getlumen.dev
                  </a>
                </p>
                <p>
                  <strong>Data Deletion Requests:</strong>{" "}
                  <a
                    href="mailto:help@getlumen.dev?subject=GDPR%20Data%20Deletion%20Request"
                    className="text-blue-600 hover:text-blue-800 underline"
                  >
                    help@getlumen.dev
                  </a>
                </p>
                <p>
                  <strong>Subject Line for Deletion:</strong> &quot;GDPR Data
                  Deletion Request&quot;
                </p>
              </div>

              <div className="mt-6 p-4 bg-blue-50 rounded-md">
                <p className="text-sm text-blue-800">
                  <strong>Data Protection Officer:</strong> For EU-related
                  privacy matters, you can contact us at the email above with
                  &quot;DPO&quot; in the subject line.
                </p>
              </div>
            </div>
          </section>

          <section className="border-t border-gray-200 pt-8">
            <p className="text-sm text-gray-500">
              This privacy policy is governed by German law and complies with
              GDPR, CCPA, and other applicable privacy regulations. Pretzel AI
              GmbH is registered in Germany and operates under German data
              protection law.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
