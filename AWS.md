# AWS

Here's a tutorial for setting up everything you need to get Gateway Lite deployed on EC2.

## Configure the AWS CLI

See also: [https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html)

We'll use environment variables to configure everything. Note that setting one of these environment variables overrides any data in `.aws`. Only explicit command line flags can override the environment variables.

When using bash, these variables will be available only in your current terminal:

```
# Essentially a username, replace XXX with your access key from the AWS web console
export AWS_ACCESS_KEY_ID=XXX
# Essentially a password, replace with your secret access key from the AWS web console
export AWS_SECRET_ACCESS_KEY=XXX
# If you choose a different region, you'll need to find the correct `--image-id` option for the `run-instances` command below.
export AWS_DEFAULT_REGION=eu-west-1
export AWS_DEFAULT_OUTPUT=json
```

## Provision a Server

Now for the main instructions, this should be copy and paste-able:

```
# Install the AWS CLI
# https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-install.html
brew install awscli

# Verify that you can connect to AWS
aws ec2 describe-regions --output text

# The `aws` command supports querying of the output with the `--query` option. We'll use it quite a lot here to extract the bits we need from the command output
export GROUP_ID=`aws ec2 create-security-group --group-name devenv-sg --description "security group for development environment" --output text`
echo "Created new security group ${GROUP_ID}"
# Allow incoming SSH 22 from any IP
aws ec2 authorize-security-group-ingress --group-name devenv-sg --protocol tcp --port 22 --cidr 0.0.0.0/0
# Create a key pair
aws ec2 create-key-pair --key-name devenv-key --query 'KeyMaterial' --output text > devenv-key.pem
# Make it secure
chmod 400 devenv-key.pem

export INSTANCE_ID=`aws ec2 run-instances --image-id ami-09f0b8b3e41191524 --security-group-ids "${GROUP_ID}" --count 1 --instance-type t2.micro --key-name devenv-key --query 'Instances[0].InstanceId' --output text`
echo "Your instance ID is ${INSTANCE_ID}."

export EC2_PUBLIC_IP=`aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output=text`
echo "Your instance is will be online at ${EC2_PUBLIC_IP} in a minute or two."
```

You can now log in with:

```
ssh -i devenv-key.pem ubuntu@$EC2_PUBLIC_IP
```

## Docker Compose


Once you have safely SSHed into the server, you can set about installing Docker and Docker Compose from the server's terminal.

Install docker:

```
sudo apt update -y
sudo apt upgrade -y
sudo apt install -y apt-transport-https ca-certificates curl software-properties-common
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu bionic stable"
sudo apt update -y
```

Now check the candidate for Docker comes from the `download.docker.com` repo
and install it:

```
apt-cache policy docker-ce
sudo apt install -y docker-ce
sudo systemctl status docker
```

Don't require sudo with docker:

```
sudo usermod -aG docker ${USER}
sudo su - ${USER}
id -nG
docker ps
```

Now install docker compose:

```
sudo curl -L https://github.com/docker/compose/releases/download/1.23.2/docker-compose-`uname -s`-`uname -m` -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
docker-compose --version
```

Now you can follow the instructions in the
[README.md](https://github.com/thejimmyg/gateway-lite) for writing a Docker
Compose file, creating the directory structures required and running a server.

When you are done, exit the server.

## SMTP (SES)

Back on the machine you used to provision a VM and with the same environment variables in place, you can following instructions to enable an SMTP for sending email.

SES isn't available in London, so make sure you've chosen Ireland:

```
export AWS_DEFAULT_REGION=eu-west-1
```

To send email from SES you need to verify your email address or an entire
domain.

If you verify an entire domain, you can send emails from all that domain e.g.
user1@example.com, user2@example.com etc.

Instead, we'll just verify one identity:

```
export EMAIL_ADDRESS=user1@example.com
aws ses verify-email-identity --email-address "${EMAIL_ADDRESS}"
```

Now wait a few moments and check your email, click the link and follow the instructions to verify.

Create an IAM user to use for SMTP credentials:

```
aws iam create-user --user-name smtp
aws iam put-user-policy --user-name smtp --policy-name 'send-email' --policy-document '{ "Statement": [{"Effect":"Allow", "Action":"ses:SendRawEmail", "Resource":"*" }]}'
export CREDS=`aws iam create-access-key --user-name smtp --query "AccessKey.{AccessKeyId:AccessKeyId,SecretAccessKey:SecretAccessKey}" --output=text`
export SMTP_USERNAME=`echo "$CREDS" | awk '{print $1}'`
export SECRET_ACCESS_KEY_FOR_SMTP=`echo "$CREDS" | awk '{print $2}'`
export SMTP_PASSWORD=`(echo -en "\x02"; echo -n 'SendRawEmail' \
  | openssl dgst -sha256 -hmac $SECRET_ACCESS_KEY_FOR_SMTP -binary) \
  | openssl enc -base64`
echo "Username: $SMTP_USERNAME Password: $SMTP_PASSWORD"
```

You can now send an email using SMTP.

**Caution: Make sure you use your *SMTP* credentials and not your AWS credentials, and make sure you use a secure TLS transport.**

Here's an example of using an SMTP server with these credentials from node.

First install `nodemailer`:

```
npm install nodemailer
```

Then create this `send.js` script with the correct credentials:

```
cat << EOF > send.js
const nodemailer = require('nodemailer')

const poolConfig = {
    pool: false,
    host: 'email-smtp.${AWS_DEFAULT_REGION}.amazonaws.com',
    port: 465,
    secure: true, // use TLS
    auth: {
        user: '$SMTP_USERNAME',
        pass: '$SMTP_PASSWORD'
    }
}

const transporter = nodemailer.createTransport(poolConfig)

// verify connection configuration
transporter.verify(function(error, success) {
   if (error) {
        console.log(error);
   } else {
        console.log('Server is ready to take our messages');
   }
});

const message = {
    from: '$EMAIL_ADDRESS',
    to: '$EMAIL_ADDRESS',
    subject: 'Test Message',
    text: 'Plaintext version of the message',
    html: '<p>HTML version of the message</p>'
};


transporter.sendMail(message, (err, info) => {
  if (err) {
    console.error(err)
  } else {
     console.info(info)
  }
})
EOF
```

Check the credentials and SMTP server address are set up correctly then test it out like this:

```
node send.js
```

## Cleaning up

Here are some commands that will help you clean up everything that you've just created.

**CAUTION: Make sure you understand what these commands to before running them.**

```
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --query "TerminatingInstances[0].CurrentState.Name" --output=text
# You have to wait for the instance to stop before continuing, but you can run the command above multiple times safely until you see `terminated`.
aws ec2 delete-security-group --group-name devenv-sg  --output text
aws ec2 delete-key-pair --key-name devenv-key --output text
rm -f devenv-key.pem
aws ses delete-identity --identity "$EMAIL_ADDRESS"
aws iam delete-user-policy --user-name smtp --policy-name 'send-email'
aws iam delete-access-key --user-name smtp --access-key-id "$SMTP_USERNAME"
aws iam delete-user --user-name smtp
```
