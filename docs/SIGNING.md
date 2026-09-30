# Code signing with Azure Artifact Signing

How to set up Windows code signing for Happy Wheels Multiplayer with **Azure Artifact Signing** (formerly *Trusted Signing*), as an individual developer. Once it's set up, every release built by GitHub Actions is signed automatically.

The release workflow (`.github/workflows/release.yml`) already supports it. It signs as soon as three repository secrets and four repository variables exist (part 9), checks the signature, and otherwise builds unsigned exactly as before.

## Before you start

- **Where you live.** Individual developers must live in the **United States or Canada**.
- **What you need:** a government photo ID (driver's license, passport or state ID), a smartphone with the **Microsoft Authenticator** app installed, and your phone number.
- **Cost:** the Basic plan is **$9.99 per month** (5,000 signatures a month, far more than needed). It's billed in full for each month from the day you create the account, not pro-rated.
- **A paid Azure subscription.** Free, trial and sponsored subscriptions can't use Artifact Signing, so a new Azure account has to be upgraded to pay-as-you-go (part 1).
- **Your name becomes public.** The certificate shows your **legal name, city, state/province and country**, and Windows shows that name as the verified publisher of the installer. Anyone can see it.
- **Keep it going once you start.** From the first signed release on, installed copies of the mod only accept updates signed with the same name. Before cancelling Azure, release an update that turns that check off, otherwise players stop receiving updates.
- **SmartScreen may still warn at first.** Signing proves who published the file, but Windows builds reputation over time as people download signed releases.

Write down each value marked **📝** as you go. You need them in part 9.

## Part 1: Azure account, paid subscription, billing details

1. Go to [portal.azure.com](https://portal.azure.com) and sign in with the Microsoft account you'll use for all of this. 📝 Note its **email address**: identity verification in part 5 must be done with the same email.
2. In the search bar at the top, type **Subscriptions** and open it. Select your subscription and look at **Offer** on its **Overview**.
3. If the offer is a free trial (*Free Trial*, *Azure free account*, *Azure for Students*), upgrade it:
   1. On the subscription's **Overview**, select **Upgrade subscription** in the bar at the top. If it isn't there, select the upgrade banner at the top of the page.
   2. Add a payment card if asked, and verify your phone number if asked.
   3. Type a name for the subscription, for example `Happy Wheels Multiplayer`.
   4. For the support plan, pick the free option (**Basic**).
   5. Select **Upgrade**. The offer now reads *Pay-As-You-Go*.
4. In the search bar, type **Cost Management + Billing** and open it, then select **Properties** in the left menu.
   - The account type must be **Individual**.
   - The **Sold-to** name and address must **exactly match your government ID** (same spelling, same name order). If they don't, select **Update sold to**, fix them and select **Save**. This name and address are copied into your certificate.

## Part 2: Turn on the code signing service

1. Search **Subscriptions** and open your subscription.
2. In the left menu under **Settings**, select **Resource providers**.
3. In the filter box, type `Microsoft.CodeSigning`, then select that row.
4. Select **Register** at the top (or **…** → **Register**). Wait until the status reads **Registered**. Select **Refresh** if it doesn't update.

## Part 3: Create the Artifact Signing account

1. In the search bar, type **Artifact Signing Accounts** and open it. Select **Create**.
2. Fill in:
   - **Subscription:** your pay-as-you-go subscription.
   - **Resource group:** select **Create new** and type `hwmp-signing`.
   - **Account name:** for example `hwmpsigning`. It must be 3 to 24 letters and numbers, start with a letter, not start with "one", and be unique in all of Azure. If it's taken, add some digits. 📝 **Account name**
   - **Region:** **East US**, or another US region from the table below. 📝 **Endpoint** for that region.
   - **Pricing:** **Basic**.
3. Select **Review + Create**, then **Create**. When it finishes, select **Go to resource**.

| Region | Endpoint |
| --- | --- |
| East US | `https://eus.codesigning.azure.net/` |
| West US | `https://wus.codesigning.azure.net/` |
| West US 2 | `https://wus2.codesigning.azure.net/` |
| West US 3 | `https://wus3.codesigning.azure.net/` |
| Central US | `https://cus.codesigning.azure.net/` |
| North Central US | `https://ncus.codesigning.azure.net/` |
| South Central US | `https://scus.codesigning.azure.net/` |
| West Central US | `https://wcus.codesigning.azure.net/` |

## Part 4: Allow yourself to verify your identity

Even as the subscription owner you need this role, otherwise the **New identity** button stays greyed out.

1. In your Artifact Signing account, select **Access control (IAM)** in the left menu.
2. Select **Add**, then **Add role assignment**.
3. On the **Role** tab, search `Artifact Signing Identity Verifier`, select it, then **Next**.
4. On the **Members** tab, keep **User, group, or service principal**, select **+ Select members**, pick **your own account**, then **Select**.
5. Select **Review + assign**, then **Review + assign** again.
6. Wait about 5 minutes, then refresh the page.

## Part 5: Verify your identity

1. In your Artifact Signing account, under **Objects** in the left menu, select **Identity validations**.
2. Change the dropdown from **Organization** to **Individual**, then select **New identity**, then **Public**.
3. Select your **billing account**. The form fills in from it and can't be edited here (fix mistakes in the billing account, part 1 step 4).
4. Check the **Certificate subject preview**. 📝 Write down the **CN** exactly as shown, character for character (for example `Jane Q Public`). This is your **publisher name**.
5. Select **Create**. The status becomes **In Progress**.
6. Wait for the status to change to **Action Required**. Refresh now and then; you also get an email.
7. Select **your name** in the list. In the panel that opens, select the link under **Please complete your verification here**.
8. Sign in with the **same email** as in step 1 of part 1. (A different account gives "You don't have permission to access this page".)
9. Select **Get verified here through our trusted ID-verifiers**. This opens AU10TIX, Microsoft's ID-check partner:
   1. Select **Let's Begin** and enter the same email address.
   2. Enter the PIN code from the email AU10TIX sends you.
   3. Enter your phone number.
   4. Select **Start**, then scan the QR code with your phone's camera. **Keep the computer's browser open.**
   5. On your phone, select **Start** and follow the steps: photograph your ID (flat surface, no flash, all four corners visible, no fingers over it) and take a selfie in good light.
   6. When the phone says it's done, select **Open Authenticator**.
10. Back in the computer's browser, scan the next QR code with the Authenticator app. Select **Add** to save the Verified ID.
11. The browser shows **Present your Verified ID**. Scan that QR code with Authenticator, select the **Verifiable Credential**, then **Share**.
12. The browser shows **Verification Successful**. Within a few minutes the status in the Azure portal changes to **Completed**. If Microsoft needs more documents, you get an email and the status shows **Action Required** again. That can take 1 to 20 business days.

Tips: turn off any VPN, use good Wi-Fi, and keep the Authenticator app up to date. If a step fails with a name, address or face mismatch, delete the request, remove the Verified ID from Authenticator, fix the billing details, and start a new request.

## Part 6: Create the certificate profile

1. In your Artifact Signing account, under **Objects**, select **Certificate profiles**.
2. Select **Create**, then **Public Trust**.
3. **Certificate Profile Name:** for example `hwmppublic` (5 to 100 letters and numbers). 📝 **Profile name**
4. **Verified CN and O:** select your completed identity validation. Leave **Include street address** and **Include postal code** unticked, which keeps them off the public certificate.
5. Check that the CN in **Certificate Subject Preview** matches the **publisher name** you wrote down, then select **Create**.

## Part 7: Create the login that GitHub will use

GitHub signs releases with an "app registration": a login that only has permission to sign.

1. In the search bar, type **Microsoft Entra ID** and open it. On **Overview**, copy the **Tenant ID**. 📝 **Tenant ID** (not the subscription ID)
2. In the left menu, select **App registrations**, then **New registration**.
   - **Name:** `hwmp-github-signing`
   - **Supported account types:** **Accounts in this organizational directory only (Single tenant)**
   - **Redirect URI:** leave empty.
   - Select **Register**.
3. On the new app's **Overview**, copy the **Application (client) ID**. 📝 **Client ID** (not the Object ID)
4. In the left menu, select **Certificates & secrets**, the **Client secrets** tab, then **New client secret**.
   - **Description:** `github`
   - **Expires:** the longest option offered (up to 24 months). 📝 Note the **expiry date**.
   - Select **Add**.
5. **Right away**, copy the **Value** column of the new secret. 📝 **Client secret**. Azure never shows it again, and it's the *Value*, not the *Secret ID*. Keep it private: anyone with it can sign files as you.

## Part 8: Allow that login to sign

1. Open your Artifact Signing account (search **Artifact Signing Accounts** and select it), then **Access control (IAM)**.
2. Select **Add**, then **Add role assignment**.
3. On the **Role** tab, search `Artifact Signing Certificate Profile Signer`, select it, then **Next**.
4. On the **Members** tab, keep **User, group, or service principal**, select **+ Select members**, and **type** `hwmp-github-signing` in the search box. App registrations only appear when you search for them. Select it, then **Select**.
5. Select **Review + assign**, then **Review + assign** again.

## Part 9: Add the values to GitHub

1. Open [the repository's Actions settings](https://github.com/BLUNT-Chief/happywheels-multiplayer/settings/secrets/actions): **Settings → Secrets and variables → Actions**.
2. On the **Secrets** tab, select **New repository secret** three times. Names must be exactly these:

   | Name | Value |
   | --- | --- |
   | `AZURE_TENANT_ID` | Tenant ID (part 7 step 1) |
   | `AZURE_CLIENT_ID` | Client ID (part 7 step 3) |
   | `AZURE_CLIENT_SECRET` | Client secret *Value* (part 7 step 5) |

3. On the **Variables** tab, select **New repository variable** four times:

   | Name | Value | Example |
   | --- | --- | --- |
   | `AZURE_SIGNING_ENDPOINT` | Endpoint for your region (part 3) | `https://eus.codesigning.azure.net/` |
   | `AZURE_SIGNING_ACCOUNT` | Artifact Signing **account name** (part 3), not the app registration | `hwmpsigning` |
   | `AZURE_SIGNING_PROFILE` | Certificate **profile name** (part 6) | `hwmppublic` |
   | `AZURE_SIGNING_PUBLISHER` | The **CN**, exactly as in the certificate subject preview (part 5 step 4) | `Jane Q Public` |

## Part 10: Test, then release

1. Open [Actions → Release](https://github.com/BLUNT-Chief/happywheels-multiplayer/actions/workflows/release.yml), select **Run workflow**, keep branch **main**, and select **Run workflow**. This test build signs and checks everything but publishes nothing.
2. Open the run. The **Build installer** step should say *Signing with Azure Artifact Signing*, and **Check the signature** should be green and list each file as `Valid, signed by '<your name>'`.
3. If it passes, release as usual (`npm version patch`, then `git push --follow-tags`).
4. To see it yourself: download the new installer, right-click it, **Properties**, the **Digital Signatures** tab. Your name is listed; select it, then **Details**, which says *This digital signature is OK*.

## If something fails

| Symptom | Fix |
| --- | --- |
| Creating the account errors about the subscription | It's still a free or trial subscription: upgrade to pay-as-you-go (part 1). |
| **New identity** is greyed out | Assign yourself **Artifact Signing Identity Verifier** (part 4) and wait a few minutes. |
| "You don't have permission to access this page" during verification | You signed in with a different email than the one on the request. |
| The **Verified CN and O** list is empty | Identity validation isn't **Completed** yet. |
| Workflow says *Azure signing is only partly set up* | One of the 7 names in part 9 is missing or misspelled. |
| Signing fails with **403** | The app registration lacks **Artifact Signing Certificate Profile Signer** (part 8), identity validation isn't Completed, or the account/profile name variable is wrong. |
| Signing fails with **401** or an authentication error | Tenant ID, client ID or secret is wrong, or the secret expired: create a new secret (part 7 step 4) and update `AZURE_CLIENT_SECRET`. |
| **Check the signature** fails with a name mismatch | `AZURE_SIGNING_PUBLISHER` must match the certificate CN exactly. |

## Keeping it working

- **Client secret:** it expires on the date you noted. Before then, create a new one (part 7 step 4) and replace `AZURE_CLIENT_SECRET`.
- **Identity validation:** it expires yearly. Microsoft emails reminders starting 60 days before; renew in **Identity validations**. If your name or address changed, create a new identity validation and select it in the certificate profile.
- **Costs:** to get a warning if the bill ever goes up, go to **Cost Management + Billing → Budgets → Add** and set a monthly budget of, for example, $15 with an email alert.
- **Stopping:** don't delete the Artifact Signing account while releases depend on it. Release an update that turns off the updater's publisher check first, then delete the account (**Artifact Signing Accounts → your account → Delete**) and unregister `Microsoft.CodeSigning`.

Sources: [Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart), [Assign roles](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles), [Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq), [electron-builder Windows code signing](https://www.electron.build/docs/features/code-signing/code-signing-win/).
