import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service - Lumen",
  description: "Terms of Service for Lumen billing platform by Pretzel AI GmbH",
};

export default function TermsPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-16">
      <div className="prose prose-gray max-w-none">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">
          Terms of Service
        </h1>

        <p className="text-gray-600 mb-8">
          <strong>Effective Date:</strong> May 1, 2025
          <br />
          <strong>Last Updated:</strong> July 30, 2025
        </p>

        <div className="space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              1. Agreement
            </h2>
            <p className="text-gray-700 leading-relaxed">
              These Terms of Service (&quot;Terms&quot;) govern your use of the
              Lumen billing platform (&quot;Service&quot;) operated by Pretzel
              AI GmbH (&quot;Company&quot;, &quot;we&quot;, &quot;our&quot;, or
              &quot;us&quot;). By accessing or using our Service, you agree to
              be bound by these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              2. Service Description
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              Lumen is a billing and payment platform that enables businesses
              to:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>Manage customer subscriptions and billing</li>
              <li>Process payments through integrated payment providers</li>
              <li>Generate invoices and handle usage-based billing</li>
              <li>Manage customer data and payment history</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              3. Account Registration
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              To use our Service, you must:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>Provide accurate and complete registration information</li>
              <li>Maintain the security of your account credentials</li>
              <li>
                Be at least 18 years old or have legal capacity to enter
                contracts
              </li>
              <li>Use the Service only for lawful business purposes</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              4. Payment Terms
            </h2>
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  4.1 Service Fees
                </h3>
                <p className="text-gray-700 leading-relaxed">
                  Service fees are based on your selected pricing plan and
                  usage. All fees are charged in advance and are non-refundable
                  except as expressly provided in these Terms.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  4.2 Payment Processing
                </h3>
                <p className="text-gray-700 leading-relaxed">
                  Payments are processed through third-party payment providers
                  (such as Stripe). You agree to their respective terms of
                  service and privacy policies. We do not store your payment
                  card information directly.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  4.3 Failed Payments
                </h3>
                <p className="text-gray-700 leading-relaxed">
                  If payment fails, we may suspend or terminate your account
                  after reasonable notice. You remain responsible for all
                  charges incurred until termination.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              5. Data and Privacy
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              Our data processing practices are governed by our Privacy Policy.
              Key points:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>
                We process your business data and your customers&apos; data as
                outlined in our Privacy Policy
              </li>
              <li>
                You are responsible for obtaining necessary consents from your
                customers
              </li>
              <li>
                You warrant that you have the right to provide customer data to
                us for processing
              </li>
              <li>
                We implement appropriate security measures to protect all data
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              6. Acceptable Use
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              You agree not to:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>
                Use the Service for illegal activities or to violate
                others&apos; rights
              </li>
              <li>Attempt to gain unauthorized access to our systems</li>
              <li>Interfere with the proper functioning of the Service</li>
              <li>
                Use the Service to compete with us or develop competing products
              </li>
              <li>
                Process payments for prohibited businesses (gambling, adult
                content, etc.)
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              7. Service Availability
            </h2>
            <p className="text-gray-700 leading-relaxed">
              While we strive for high availability, we do not guarantee
              uninterrupted service. We may perform maintenance, updates, or
              experience outages that temporarily affect service availability.
              We are not liable for any losses resulting from service
              interruptions.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              8. Termination
            </h2>
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  8.1 By You
                </h3>
                <p className="text-gray-700 leading-relaxed">
                  You may terminate your account at any time through your
                  account settings or by contacting us. Termination does not
                  relieve you of any payment obligations incurred before
                  termination.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  8.2 By Us
                </h3>
                <p className="text-gray-700 leading-relaxed">
                  We may terminate or suspend your account for violations of
                  these Terms, non-payment, or for any reason with reasonable
                  notice.
                </p>
              </div>

              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  8.3 Effect of Termination
                </h3>
                <p className="text-gray-700 leading-relaxed">
                  Upon termination, your right to use the Service ends
                  immediately. We may delete your data according to our data
                  retention policies outlined in our Privacy Policy.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              9. Limitation of Liability
            </h2>
            <p className="text-gray-700 leading-relaxed mb-4">
              To the maximum extent permitted by law:
            </p>
            <ul className="list-disc list-inside text-gray-700 space-y-2">
              <li>
                Our total liability to you shall not exceed the fees paid by you
                in the 12 months preceding the claim
              </li>
              <li>
                We are not liable for indirect, incidental, special, or
                consequential damages
              </li>
              <li>
                We are not liable for losses resulting from third-party payment
                processor issues
              </li>
              <li>
                You agree to indemnify us against claims arising from your use
                of the Service
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              10. Warranty Disclaimer
            </h2>
            <p className="text-gray-700 leading-relaxed">
              The Service is provided &quot;as is&quot; without warranties of
              any kind. We disclaim all warranties, express or implied,
              including warranties of merchantability, fitness for a particular
              purpose, and non-infringement.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              11. Changes to Terms
            </h2>
            <p className="text-gray-700 leading-relaxed">
              We may modify these Terms at any time. We will notify you of
              material changes via email or through the Service. Your continued
              use of the Service after such notification constitutes acceptance
              of the modified Terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              12. Governing Law
            </h2>
            <p className="text-gray-700 leading-relaxed">
              These Terms are governed by German law. Any disputes shall be
              resolved in the courts of Berlin, Germany. If you are a consumer,
              you may also bring proceedings in your country of residence.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">
              13. Contact Information
            </h2>
            <div className="bg-gray-50 p-6 rounded-lg">
              <p className="text-gray-700 leading-relaxed">
                If you have questions about these Terms, please contact us:
              </p>
              <div className="mt-4 text-gray-700">
                <p>
                  <strong>Pretzel AI GmbH</strong>
                </p>
                <p>
                  Email:{" "}
                  <a
                    href="mailto:help@getlumen.dev"
                    className="text-blue-600 hover:text-blue-800 underline"
                  >
                    help@getlumen.dev
                  </a>
                </p>
                <p>
                  Address: c/o Prasoon Shukla, Jungstraße 12, 10247 Berlin,
                  Germany
                </p>
              </div>
            </div>
          </section>

          <section className="border-t border-gray-200 pt-8">
            <p className="text-sm text-gray-500">
              These Terms of Service are governed by German law and comply with
              EU regulations.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
